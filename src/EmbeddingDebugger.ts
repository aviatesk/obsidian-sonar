import { Notice } from 'obsidian';
import { WithLogging } from './WithLogging';
import type { ConfigManager } from './ConfigManager';
import type { Embedder } from './Embedder';
import { promises as fs } from 'fs';

export class DebugRunner extends WithLogging {
  protected readonly componentName = 'DebugRunner';

  constructor(
    protected configManager: ConfigManager,
    private embedder: Embedder
  ) {
    super();
  }

  generateSampleEmbeddings(): void {
    try {
      this._generateSampleEmbeddings();
    } catch (error) {
      this.error(`Debug failed: ${error}`);
      new Notice('Debug failed - check console');
    }
  }

  private async _generateSampleEmbeddings(): Promise<void> {
    let inputDir = this.configManager.get('debugSamplesPath');
    if (!inputDir) {
      new Notice('Debug path not configured');
      return;
    }
    const outputDir = `${inputDir}/sample_embeddings`;
    const files = await fs.readdir(`${inputDir}/sample_texts`);
    const txtFiles = files.filter(f => f.endsWith('.txt')).sort();
    if (txtFiles.length === 0) {
      this.error('No .txt files found in debug directory');
      new Notice('No .txt files found in debug directory');
      return;
    }

    this.log(`========== Generating Sample Embeddings ==========`);
    this.log(`Input directory: ${inputDir}`);
    this.log(`Found ${txtFiles.length} .txt files`);

    await fs.mkdir(outputDir, { recursive: true });

    const outputFiles = await fs.readdir(outputDir);
    const oldEmbeddings = outputFiles.filter(f =>
      f.startsWith('transformersjs_embedding_')
    );
    for (const oldFile of oldEmbeddings) {
      await fs.unlink(`${outputDir}/${oldFile}`);
      this.log(`Deleted old file: ${oldFile}`);
    }

    for (let i = 0; i < txtFiles.length; i++) {
      const txtFile = txtFiles[i];
      const filePath = `${inputDir}/sample_texts/${txtFile}`;
      const text = (await fs.readFile(filePath, 'utf-8')).trim();

      if (!text) {
        this.log(`Skipping empty file: ${txtFile}`);
        continue;
      }

      this.log(`Processing: ${txtFile}`);
      this.log(`  Text: ${text.slice(0, 50)}...`);

      const embedding = await this.embedder.getEmbeddings([text], 'query');
      const emb = embedding[0];

      const l2norm = Math.sqrt(emb.reduce((sum, val) => sum + val * val, 0));

      this.log(`  Dimension: ${emb.length}`);
      this.log(
        `  First 5: [${emb
          .slice(0, 5)
          .map(v => v.toFixed(6))
          .join(', ')}]`
      );
      this.log(`  L2 norm: ${l2norm.toFixed(6)}`);

      const output = {
        text: text,
        embedding: emb,
        l2_norm: l2norm,
        first_5: emb.slice(0, 5),
      };

      const fileStem = txtFile.replace(/\.txt$/, '');
      const outputPath = `${outputDir}/transformersjs_embedding_${fileStem}.json`;
      await fs.writeFile(outputPath, JSON.stringify(output, null, 2), 'utf-8');
      this.log(`  Saved to ${outputPath}`);
    }

    this.log(`Generated ${txtFiles.length} embeddings`);
    this.log(`Output directory: ${outputDir}`);
    this.log(
      `\nNext: Run 'uv run debug/compare_sample_embeddings.py' to compare with Python embeddings`
    );
    new Notice(`Generated ${txtFiles.length} embeddings - check console`, 5000);
  }
}
