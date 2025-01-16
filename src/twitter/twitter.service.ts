import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
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

  private async checkMentions(userId: string): Promise<any> {
    try {
      const mentions = await this.twitterClient.v2.userMentionTimeline(userId, {
        max_results: 5,
        "tweet.fields": ["created_at", "text", "author_id"],
        expansions: ["author_id"],
        "user.fields": ["username"],
      });

      if (mentions.data.data && mentions.data.data.length > 0) {
        this.logger.log(`Found ${mentions.data.data.length} mentions`);
        mentions.data.data.forEach(tweet => {
          this.logger.log(`Tweet ${tweet.id} from ${tweet.created_at}: ${tweet.text}`);
        });
      } else {
        this.logger.log('No mentions found in the response');
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

  private async replyToTweet(tweetId: string, replyText: string): Promise<boolean> {
    try {
      await this.twitterClient.v2.reply(replyText, tweetId);
      return true;
    } catch (error) {
      this.logger.error(`Failed to reply to tweet ${tweetId}:`, error);
      return false;
    }
  }

  private async generateAiResponse(tweetText: string): Promise<string> {
    try {
      const response = await this.openAiClient.chat.completions.create({
        model: "gpt-4",
        messages: [
          {
            role: "system",
            content: "You are a helpful but slightly sassy assistant. Keep responses under 240 characters and suitable for Twitter."
          },
          {
            role: "user",
            content: `Please respond to this tweet: ${tweetText}`
          }
        ],
        max_tokens: 100,
        temperature: 0.7
      });

      return response.choices[0].message.content;
    } catch (error) {
      this.logger.error('Error generating AI response:', error);
      return "Sorry, I'm having trouble thinking of a response right now! 🤔";
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
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "You are a token request analyzer. Determine if the tweet is requesting token creation. Respond with either 'YES' or 'NO'."
          },
          {
            role: "user",
            content: `Is this tweet requesting token creation? Tweet: ${tweetText}`
          }
        ],
        max_tokens: 10,
        temperature: 0.1
      });

      const decision = response.choices[0].message.content.trim().toUpperCase();
      
      // Log the analysis
      this.logger.log('\nTweet Analysis:');
      this.logger.log(`Tweet: ${tweetText}`);
      this.logger.log(`Decision: ${decision}`);
      
      return decision === "YES";
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
      this.logger.log('\nStarting mention check job...');
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

      const mentions = await this.checkMentions(userId);
      
      if (mentions?.data) {
        for (const tweet of [...mentions.data].reverse()) {
          if (this.respondedTweets.has(tweet.id)) {
            this.logger.log(`Already responded to tweet ${tweet.id}, skipping...`);
            continue;
          }

          if (this.repliesToday >= 17) {
            this.logger.log('Hit reply limit during processing. Waiting for next day...');
            break;
          }

          // Check if tweet is requesting token creation
          const isTokenRequest = await this.analyzeTokenIntent(tweet.text);
          
          if (isTokenRequest) {
            const replyText = this.generateTokenResponse();
            if (await this.replyToTweet(tweet.id, replyText)) {
              this.repliesToday++;
              this.respondedTweets.add(tweet.id);
              this.logger.log(`Replied to token request tweet ${tweet.id} (Replies today: ${this.repliesToday}/17)`);
            } else {
              this.logger.error(`Failed to reply to tweet ${tweet.id}`);
            }
          } else {
            this.logger.log(`Tweet ${tweet.id} is not a token request, skipping...`);
            this.respondedTweets.add(tweet.id);  // Mark as processed
          }
        }
      }

      this.logger.log('\nWaiting 15 minutes before next check...');
    } catch (error) {
      this.logger.error('\nAn error occurred:', error);
    }
  }
}
