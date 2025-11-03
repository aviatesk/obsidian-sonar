#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, basename } from 'path';

interface LineMessage {
  date: string;
  time: string;
  sender: string;
  content: string;
  metadata: {
    dayOfWeek: string;
    isSpecial: boolean;
    hasUrl: boolean;
  };
}

interface LineConversation {
  participants: Set<string>;
  dateRange: {
    start: string;
    end: string;
  };
  messagesByDate: Map<string, LineMessage[]>;
}

class LineMessageParser {
  private datePattern = /^(\d{4}\.\d{2}\.\d{2})\s+(\w+)$/;
  private myName: string;
  private otherParticipants: string[];

  constructor(myName: string, otherParticipants: string[]) {
    this.myName = myName;
    this.otherParticipants = otherParticipants;
  }

  parse(text: string): LineConversation {
    const lines = text.split('\n');
    let currentDate = '';
    let currentDayOfWeek = '';
    const messages: LineMessage[] = [];
    let pendingMessage: Partial<LineMessage> | null = null;

    for (const line of lines) {
      if (!line.trim()) continue;

      const dateMatch = line.match(this.datePattern);
      if (dateMatch) {
        if (pendingMessage) {
          messages.push(pendingMessage as LineMessage);
          pendingMessage = null;
        }
        currentDate = dateMatch[1].replace(/\./g, '-');
        currentDayOfWeek = dateMatch[2];
        continue;
      }

      const msgMatch = this.parseMessageLine(line);
      if (msgMatch) {
        if (pendingMessage) {
          messages.push(pendingMessage as LineMessage);
        }

        pendingMessage = {
          date: currentDate,
          time: msgMatch.time,
          sender: msgMatch.sender,
          content: msgMatch.content,
          metadata: {
            dayOfWeek: currentDayOfWeek,
            isSpecial: this.isSpecialMessage(msgMatch.content),
            hasUrl: this.hasUrl(msgMatch.content),
          },
        };
      } else if (line.trim() && pendingMessage) {
        pendingMessage.content += '\n' + line;
        if (this.hasUrl(line)) {
          pendingMessage.metadata!.hasUrl = true;
        }
      }
    }

    if (pendingMessage) {
      messages.push(pendingMessage as LineMessage);
    }

    return this.buildConversation(messages);
  }

  private parseMessageLine(
    line: string
  ): { time: string; sender: string; content: string } | null {
    const timeMatch = line.match(/^(\d{2}:\d{2})\s+(.+)$/);
    if (!timeMatch) return null;

    const time = timeMatch[1];
    const rest = timeMatch[2];

    const allParticipants = [this.myName, ...this.otherParticipants];

    for (const participant of allParticipants) {
      if (rest.startsWith(participant + ' ')) {
        return {
          time,
          sender: participant,
          content: rest.substring(participant.length + 1),
        };
      }
    }

    return null;
  }

  private isSpecialMessage(content: string): boolean {
    const specialPatterns = ['Stickers', 'Photo', 'Video', 'File'];
    return specialPatterns.some(pattern => content.includes(pattern));
  }

  private hasUrl(content: string): boolean {
    return /https?:\/\//.test(content);
  }

  private buildConversation(messages: LineMessage[]): LineConversation {
    const participants = new Set<string>();
    const messagesByDate = new Map<string, LineMessage[]>();
    let startDate = '';
    let endDate = '';

    for (const message of messages) {
      participants.add(message.sender);

      if (!startDate || message.date < startDate) {
        startDate = message.date;
      }
      if (!endDate || message.date > endDate) {
        endDate = message.date;
      }

      if (!messagesByDate.has(message.date)) {
        messagesByDate.set(message.date, []);
      }
      messagesByDate.get(message.date)!.push(message);
    }

    return {
      participants,
      dateRange: { start: startDate, end: endDate },
      messagesByDate,
    };
  }
}

function extractParticipantsFromFilename(filename: string): string[] {
  const match = filename.match(/^\[LINE\](.+)\.(?:txt|md)$/);
  if (!match) {
    throw new Error(
      `Invalid filename format: ${filename}. Expected format: [LINE]<name1>, <name2>.txt`
    );
  }

  const namesString = match[1];
  return namesString.split(',').map(name => name.trim());
}

class MarkdownGenerator {
  generateForDate(
    date: string,
    messages: LineMessage[],
    allParticipants: Set<string>,
    otherParticipants: string[]
  ): string {
    const dayOfWeek = messages[0]?.metadata.dayOfWeek || '';
    const participants = Array.from(allParticipants).join(', ');
    const chatPartners = otherParticipants.join(', ');

    let md = '---\n';
    md += `date: ${date}\n`;
    md += `day-of-week: ${dayOfWeek}\n`;
    md += `participants: [${Array.from(allParticipants)
      .map(p => `"${p}"`)
      .join(', ')}]\n`;
    md += `chat-partners: [${otherParticipants.map(p => `"${p}"`).join(', ')}]\n`;
    md += 'tags:\n  - LINE\n  - chat\n';
    md += '---\n';
    md += `# LINE Chat - ${chatPartners} - ${date} (${dayOfWeek})\n\n`;
    md += `Participants: ${participants}\n\n`;
    md += '---\n\n';

    for (const message of messages) {
      md += `## ${message.time} - ${message.sender}\n\n`;
      md += `${message.content}\n\n`;

      if (message.metadata.hasUrl || message.metadata.isSpecial) {
        md += '*';
        if (message.metadata.hasUrl) md += ' [Contains URL]';
        if (message.metadata.isSpecial) md += ' [Special Message]';
        md += '*\n\n';
      }
    }

    return md;
  }
}

function parseAndSaveLineChat(
  inputPath: string,
  myName: string,
  outputBaseDir?: string
): void {
  console.log(`Processing: ${inputPath}`);

  const inputBasename = basename(inputPath);
  const participantsFromFilename =
    extractParticipantsFromFilename(inputBasename);

  const otherParticipants = participantsFromFilename.filter(
    name => name !== myName
  );

  if (otherParticipants.length === 0) {
    console.warn(
      `  Warning: No other participants found. All names in filename matched your name.`
    );
  }

  const content = readFileSync(inputPath, 'utf-8');
  const parser = new LineMessageParser(myName, otherParticipants);
  const conversation = parser.parse(content);

  if (conversation.messagesByDate.size === 0) {
    console.warn(`  No messages found in ${inputPath}`);
    return;
  }

  const basenameWithoutExt = inputBasename.replace(/\.(?:txt|md)$/, '');
  let outputDir: string;

  if (outputBaseDir) {
    outputDir = join(outputBaseDir, `${basenameWithoutExt}`);
  } else {
    const inputDir = dirname(inputPath);
    outputDir = join(inputDir, `${basenameWithoutExt}`);
  }

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const generator = new MarkdownGenerator();
  let createdCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;

  const chatPartnersString = otherParticipants.join(', ');

  for (const [date, messages] of conversation.messagesByDate.entries()) {
    const outputFilename = `${date} ${chatPartnersString}.md`;
    const outputPath = join(outputDir, outputFilename);

    const newContent = generator.generateForDate(
      date,
      messages,
      conversation.participants,
      otherParticipants
    );

    if (existsSync(outputPath)) {
      const existingContent = readFileSync(outputPath, 'utf-8');
      if (existingContent === newContent) {
        skippedCount++;
        continue;
      }
      updatedCount++;
    } else {
      createdCount++;
    }

    writeFileSync(outputPath, newContent, 'utf-8');
  }

  console.log(`  Output directory: ${outputDir}`);
  console.log(
    `  Created: ${createdCount}, Updated: ${updatedCount}, Skipped: ${skippedCount}`
  );
  console.log(
    `  Date range: ${conversation.dateRange.start} to ${conversation.dateRange.end}`
  );
  console.log(
    `  Participants: ${Array.from(conversation.participants).join(', ')}`
  );
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(
      'Usage: parse-line-chat --my-name <name> [--output-dir <dir>] <file1> [file2] ...'
    );
    console.log(
      '\nParses LINE chat export files and saves structured markdown output.'
    );
    console.log('\nOptions:');
    console.log(
      '  --my-name <name>       Your name as it appears in the chat (required)'
    );
    console.log(
      '  --output-dir <dir>     Base directory for output (optional)'
    );
    console.log(
      '                         If not specified, output will be saved next to each input file'
    );
    console.log('\nExamples:');
    console.log(
      '  parse-line-chat --my-name "John Doe" "[LINE]Jane Smith.txt"'
    );
    console.log(
      '  parse-line-chat --my-name "John Doe" --output-dir ./parsed "[LINE]Jane.txt"'
    );
    process.exit(args.length === 0 ? 1 : 0);
  }

  const myNameIndex = args.indexOf('--my-name');
  if (myNameIndex === -1 || myNameIndex + 1 >= args.length) {
    console.error('Error: --my-name option is required');
    console.error(
      'Usage: parse-line-chat --my-name <name> [--output-dir <dir>] <file1> [file2] ...'
    );
    process.exit(1);
  }

  const myName = args[myNameIndex + 1];

  const outputDirIndex = args.indexOf('--output-dir');
  const outputDir =
    outputDirIndex !== -1 && outputDirIndex + 1 < args.length
      ? args[outputDirIndex + 1]
      : undefined;

  const files = args.filter(
    (arg, index) =>
      arg !== '--my-name' &&
      arg !== '--output-dir' &&
      index !== myNameIndex + 1 &&
      index !== outputDirIndex + 1 &&
      !arg.startsWith('--')
  );

  if (files.length === 0) {
    console.error('Error: No input files specified');
    console.error(
      'Usage: parse-line-chat --my-name <name> [--output-dir <dir>] <file1> [file2] ...'
    );
    process.exit(1);
  }

  console.log(`My name: ${myName}`);
  if (outputDir) {
    console.log(`Output directory: ${outputDir}`);
  }
  console.log(`Processing ${files.length} file(s)...\n`);

  for (const inputPath of files) {
    if (!existsSync(inputPath)) {
      console.error(`Error: File not found: ${inputPath}`);
      continue;
    }

    try {
      parseAndSaveLineChat(inputPath, myName, outputDir);
    } catch (error) {
      console.error(`Error processing ${inputPath}:`, error);
    }
    console.log();
  }

  console.log('Done!');
}

main();
