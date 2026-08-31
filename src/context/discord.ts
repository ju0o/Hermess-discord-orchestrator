export interface DiscordContextMessage { source: string; author: string; content: string; timestamp: string; }
export interface DiscordContextSource {
  fetchThread(threadId: string, limit?: number): Promise<DiscordContextMessage[]>;
  fetchChannel(channelId: string, limit?: number): Promise<DiscordContextMessage[]>;
}

export class NullDiscordContextSource implements DiscordContextSource {
  async fetchThread(): Promise<DiscordContextMessage[]> { return []; }
  async fetchChannel(): Promise<DiscordContextMessage[]> { return []; }
}
