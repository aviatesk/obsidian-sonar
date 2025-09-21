import path from 'path';
import { Ora } from 'ora';
import { OllamaUtils } from './ollama-utils';
import { readFile } from './fs-utils';
import { createChunks, createIndexedDocument } from '../src/chunker';
import { IndexedDocument } from '../src/VectorStore';

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

// 直列処理（シーケンシャル）でのインデックス作成
export async function processSequential(
  files: string[],
  config: Config,
  ollamaUtils: OllamaUtils,
  startTime: number,
  spinner: Ora
): Promise<ProcessResult> {
  const documents: IndexedDocument[] = [];
  let totalChunks = 0;

  for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
    const file = files[fileIdx];
    const fileName = path.basename(file);

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
        spinner.text = `[${fileIdx + 1}/${files.length}] Processing ${fileName} (${chunks.length} chunks)`;

        const texts = chunks.map(chunk => chunk.content);
        const embeddings = await ollamaUtils.getEmbeddings(texts);

        for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
          if (embeddings[chunkIdx]) {
            documents.push(
              createIndexedDocument(
                chunks[chunkIdx],
                embeddings[chunkIdx],
                file,
                chunkIdx,
                chunks.length
              )
            );
            totalChunks++;
          }
        }
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const speed =
        totalChunks > 0 ? (totalChunks / parseFloat(elapsed)).toFixed(1) : '0';
      spinner.text = `[${fileIdx + 1}/${files.length}] Completed ${fileName} | Total: ${totalChunks} chunks | ${speed} chunks/s`;
    } catch (error: any) {
      console.error(`Error processing ${fileName}: ${error.message}`);
    }
  }

  return { documents, totalChunks };
}
