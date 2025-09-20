import path from 'path';
import { Ora } from 'ora';
import { OllamaUtils } from './ollama-utils';
import { readFile } from './fs-utils';
import { createChunks, createIndexedDocument } from '../src/core/chunking';
import { IndexedDocument } from '../src/core/document';

interface Config {
  maxChunkSize: number;
  chunkOverlap: number;
  embeddingModel?: string;
  tokenizerModel?: string;
}

interface ProcessResult {
  documents: IndexedDocument[];
  totalChunks: number;
}

interface ServerStatus {
  currentFile: string;
  processed: number;
  total: number;
  port: number;
}

export async function processParallel(
  files: string[],
  config: Config,
  ollamaUtils: OllamaUtils,
  _totalChunks: number,
  startTime: number,
  spinner: Ora
): Promise<ProcessResult> {
  const availableServers = ollamaUtils.servers.filter(s => s.available);
  const serverStatus = new Map<string, ServerStatus>();
  let globalProcessedFiles = 0;
  let globalTotalChunks = 0;
  const documents: IndexedDocument[] = [];

  // ファイルを事前にサーバーに割り当て
  const serverBatches: { server: any; files: string[] }[] = [];
  const filesPerServer = Math.ceil(files.length / availableServers.length);

  console.log(
    `\n🎯 Distributing ${files.length} files across ${availableServers.length} servers (~${filesPerServer} files/server)\n`
  );

  for (let i = 0; i < availableServers.length; i++) {
    const start = i * filesPerServer;
    const end = Math.min(start + filesPerServer, files.length);
    const batch = files.slice(start, end);

    if (batch.length > 0) {
      serverBatches.push({
        server: availableServers[i],
        files: batch,
      });

      serverStatus.set(availableServers[i].url, {
        currentFile: '',
        processed: 0,
        total: batch.length,
        port: availableServers[i].port,
      });
    }
  }

  const updateParallelSpinner = () => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const speed =
      globalTotalChunks > 0
        ? (globalTotalChunks / parseFloat(elapsed)).toFixed(1)
        : '0';

    const serverLines: string[] = [];
    for (const [, status] of serverStatus.entries()) {
      const progress =
        status.total > 0 ? `[${status.processed}/${status.total}]` : '[done]';

      if (status.currentFile) {
        const shortName =
          status.currentFile.length > 25
            ? status.currentFile.substring(0, 22) + '...'
            : status.currentFile;
        serverLines.push(`  [Port:${status.port}] ${progress} 🔄 ${shortName}`);
      } else if (status.processed === status.total && status.total > 0) {
        serverLines.push(`  [Port:${status.port}] ${progress} ✅ completed`);
      } else {
        serverLines.push(`  [Port:${status.port}] ${progress} ⏸  waiting`);
      }
    }

    const progressBar =
      '█'.repeat(Math.floor((globalProcessedFiles / files.length) * 20)) +
      '░'.repeat(20 - Math.floor((globalProcessedFiles / files.length) * 20));
    const percentage = Math.floor((globalProcessedFiles / files.length) * 100);

    spinner.text = `📊 Progress: ${progressBar} ${percentage}% (${globalProcessedFiles}/${files.length} files)
${serverLines.join('\n')}
📈 Stats: ${globalTotalChunks} chunks | ${speed} chunks/s`;
  };

  // 各サーバーでバッチを並列処理
  const processBatch = async ({
    server,
    files: batchFiles,
  }: {
    server: any;
    files: string[];
  }) => {
    const batchDocs: IndexedDocument[] = [];
    const status = serverStatus.get(server.url)!;
    let batchChunks = 0;

    for (const file of batchFiles) {
      const fileName = path.basename(file);
      status.currentFile = fileName;
      updateParallelSpinner();

      try {
        const content = await readFile(file);
        const chunks = await createChunks(
          content,
          file,
          config,
          config.embeddingModel,
          config.tokenizerModel
        );

        if (chunks.length > 0) {
          const texts = chunks.map(chunk => chunk.content);
          const embeddings = await ollamaUtils.getEmbeddingsSingle(
            texts,
            server.url
          );

          for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
            if (embeddings[chunkIdx]) {
              batchDocs.push(
                createIndexedDocument(
                  chunks[chunkIdx],
                  embeddings[chunkIdx],
                  file,
                  chunkIdx,
                  chunks.length
                )
              );
              batchChunks++;
            }
          }
        }
      } catch (error: any) {
        console.error(`Error processing ${fileName}: ${error.message}`);
      }

      status.processed++;
      globalProcessedFiles++;
      globalTotalChunks += batchChunks;
      batchChunks = 0;
      updateParallelSpinner();
    }

    status.currentFile = '';
    updateParallelSpinner();
    return batchDocs;
  };

  updateParallelSpinner();
  const allPromises = serverBatches.map(batch => processBatch(batch));
  const results = await Promise.all(allPromises);

  for (const batchDocs of results) {
    documents.push(...batchDocs);
  }

  return { documents, totalChunks: globalTotalChunks };
}
