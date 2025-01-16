import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TwitterApi } from 'twitter-api-v2';
import { ConfigService } from '@nestjs/config';
import { OpenAI } from 'openai';

@Injectable()
export class TwitterService {
  private readonly logger = new Logger(TwitterService.name);
  private readonly twitterClient: TwitterApi;
  private readonly openAiClient: OpenAI;
  private respondedTweets = new Set<string>();
  private repliesToday = 0;
  private lastReset = new Date();
  private lastProcessedTweetId: string | null = null;
  private isFirstRun = true;

  constructor(private configService: ConfigService) {
    this.twitterClient = new TwitterApi({
      appKey: configService.get('API_KEY'),
      appSecret: configService.get('API_SECRET'),
      accessToken: configService.get('ACCESS_TOKEN'),
      accessSecret: configService.get('ACCESS_TOKEN_SECRET'),
    });

    this.openAiClient = new OpenAI({
      apiKey: configService.get('OPENAI_API_KEY'),
    });

    this.logger.log('Twitter bot service initialized');
    this.checkMentionsJob(); // Immediate first check
  }

  private async getUserId(username: string): Promise<string | null> {
    try {
      const user = await this.twitterClient.v2.userByUsername(username);
      return user.data.id;
    } catch (error) {
      this.logger.error(`Failed to get user ID for ${username}:`, error);
      return null;
    }
  }

  private async checkMentions(userId: string, options: any): Promise<any> {
    try {
      if (this.isFirstRun) {
        options.max_results = 5;
        this.isFirstRun = false;
      }

      if (this.lastProcessedTweetId) {
        options.since_id = this.lastProcessedTweetId;
      }

      const mentions = await this.twitterClient.v2.userMentionTimeline(
        userId,
        options,
      );

      if (mentions.data.data && mentions.data.data.length > 0) {
        this.lastProcessedTweetId = mentions.data.data[0].id;
        this.logger.log(
          `Found ${mentions.data.data.length} new mentions since last check`,
        );
        this.logger.log(
          `Updated last processed tweet ID to: ${this.lastProcessedTweetId}`,
        );
      } else {
        this.logger.log('No new mentions found');
      }

      return mentions.data;
    } catch (error) {
      if (error.code === 429) {
        this.logger.warn('Rate limit reached. Will retry in next cycle.');
        return null;
      }
      this.logger.error('API Error:', error);
      return null;
    }
  }

  private async replyToTweet(
    tweetId: string,
    replyText: string,
  ): Promise<boolean> {
    try {
      await this.twitterClient.v2.reply(replyText, tweetId);
      return true;
    } catch (error) {
      this.logger.error(`Failed to reply to tweet ${tweetId}:`, error);
      return false;
    }
  }

  private checkAndResetDaily() {
    const now = new Date();
    if (now.getDate() !== this.lastReset.getDate()) {
      this.repliesToday = 0;
      this.lastReset = now;
      this.logger.log('Daily reset: Updated reply counter');
    }
  }

  private async analyzeTokenIntent(tweetText: string): Promise<boolean> {
    try {
      const response = await this.openAiClient.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content:
              "You are a token request analyzer. Determine if the tweet is requesting token creation. Respond with either 'YES' or 'NO'.",
          },
          {
            role: 'user',
            content: `Is this tweet requesting token creation? Tweet: ${tweetText}`,
          },
        ],
        max_tokens: 10,
        temperature: 0.1,
      });

      const decision = response.choices[0].message.content.trim().toUpperCase();
      // Log the analysis
      this.logger.log('\nTweet Analysis:');
      this.logger.log(`Tweet: ${tweetText}`);
      this.logger.log(`Decision: ${decision}`);
      return decision === 'YES';
    } catch (error) {
      this.logger.error('Error analyzing tweet intent:', error);
      return false;
    }
  }

  private generateTokenResponse(): string {
    return "Sure, I'll help create your token! The process will begin shortly. Please wait for confirmation. 🎮🔨";
  }

  @Cron('*/15 * * * *')
  async checkMentionsJob() {
    try {
      this.logger.log('\n=== Starting mention check job ===');
      const username = this.configService.get('TWITTER_USER_NAME');
      this.logger.log(`Checking mentions for user: ${username}`);

      const userId = await this.getUserId(username);
      if (!userId) {
        this.logger.error('Failed to get user ID');
        return;
      }

      this.logger.log(`Found user ID: ${userId}`);
      this.logger.log(`Current replies today: ${this.repliesToday}/17`);

      this.checkAndResetDaily();

      if (this.repliesToday >= 17) {
        this.logger.log('Daily reply limit reached. Waiting for next day...');
        return;
      }

      const mentions = await this.checkMentions(userId, {
        'tweet.fields': ['created_at', 'text', 'author_id'],
        expansions: ['author_id'],
        'user.fields': ['username'],
      });
      if (mentions?.data) {
        for (const tweet of [...mentions.data].reverse()) {
          this.logger.log('\n--- Processing Tweet ---');
          this.logger.log(`Tweet ID: ${tweet.id}`);
          this.logger.log(`Author ID: ${tweet.author_id}`);
          this.logger.log(`Content: ${tweet.text}`);

          // Skip if tweet is from ourselves
          if (tweet.author_id === userId) {
            this.logger.log('⚠️ Tweet is from ourselves, skipping...');
            continue;
          }

          // Check if we've already responded to this tweet
          if (this.respondedTweets.has(tweet.id)) {
            this.logger.log('⚠️ Already responded to this tweet, skipping...');
            continue;
          }

          // Check if this tweet is a reply to one we've already handled
          const isReplyToHandledTweet = mentions.data.some(
            (t) => tweet.text.includes(t.id) && this.respondedTweets.has(t.id),
          );
          if (isReplyToHandledTweet) {
            this.logger.log(
              '⚠️ Tweet is a reply to an already handled tweet, skipping...',
            );
            this.respondedTweets.add(tweet.id);
            continue;
          }

          if (this.repliesToday >= 17) {
            this.logger.log(
              '⚠️ Hit reply limit during processing. Waiting for next day...',
            );
            break;
          }

          // Analyze tweet intent
          this.logger.log('🔍 Analyzing tweet intent...');
          const isTokenRequest = await this.analyzeTokenIntent(tweet.text);
          this.logger.log(
            `Analysis result: ${isTokenRequest ? 'Token request detected' : 'Not a token request'}`,
          );

          if (isTokenRequest) {
            const replyText = this.generateTokenResponse();
            this.logger.log(`💬 Attempting to reply with: "${replyText}"`);

            if (await this.replyToTweet(tweet.id, replyText)) {
              this.repliesToday++;
              this.respondedTweets.add(tweet.id);
              this.logger.log(
                `✅ Successfully replied to token request tweet ${tweet.id}`,
              );
              this.logger.log(`Current reply count: ${this.repliesToday}/17`);
            } else {
              this.logger.error(`❌ Failed to reply to tweet ${tweet.id}`);
            }
          } else {
            this.logger.log(
              '⏭️ Not a token request, marking as processed and skipping...',
            );
            this.respondedTweets.add(tweet.id);
          }
        }
      }

      this.logger.log(
        '\n=== Job completed, waiting 15 minutes before next check... ===',
      );
    } catch (error) {
      this.logger.error('\n❌ An error occurred:', error);
    }
  }
}
