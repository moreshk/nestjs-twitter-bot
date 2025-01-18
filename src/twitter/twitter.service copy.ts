/* eslint-disable @typescript-eslint/no-unused-vars */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TwitterApi } from 'twitter-api-v2';
import { ConfigService } from '@nestjs/config';
import { OpenAI } from 'openai';
import { Keypair } from "@solana/web3.js";
import * as nacl from "tweetnacl";
import { encodeUTF8, decodeUTF8 } from "tweetnacl-util";
import bs58 from "bs58";
import axios from "axios";
import FormData = require('form-data');

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
  private readonly API_BASE_URL = "https://api.cybers.app/v1";

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
      // await this.twitterClient.v2.reply(replyText, tweetId);
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

  private async analyzeTokenDetails(tweetText: string): Promise<{ name: string; symbol: string } | null> {
    try {
      const response = await this.openAiClient.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'You are a token name analyzer. Extract the token name and symbol from the tweet. Respond with a JSON object containing "name" and "symbol" fields. If only one is found, use it for both. Example: {"name": "MyToken", "symbol": "MTK"}. If no valid name/symbol found, respond: {"name": null, "symbol": null}',
          },
          {
            role: 'user',
            content: `Extract the token name and symbol from this tweet: ${tweetText}`,
          },
        ],
        max_tokens: 100,
        temperature: 0.1,
      });

      // Clean the response of any markdown formatting
      const cleanedContent = response.choices[0].message.content
        .trim()
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();

      const result = JSON.parse(cleanedContent);
      if (!result.name || !result.symbol) {
        return null;
      }

      // Log the analysis results
      this.logger.log('Token Details Analysis:');
      this.logger.log(`Name: ${result.name}`);
      this.logger.log(`Symbol: ${result.symbol}`);      

      return {
        name: result.name,
        symbol: result.symbol
      };
    } catch (error) {
      this.logger.error('Error analyzing token details:', error);
      return null;
    }
  }

  private async createCoin(name: string, symbol: string): Promise<boolean> {
    try {
      // 1. Setup wallet (using a dummy keypair for testing)
      const keypair = Keypair.generate();
      const walletAddress = keypair.publicKey.toString();

      // 2. Create and sign the authentication message
      const message = "Sign in to Cyber";
      const messageBytes = decodeUTF8(message);
      const signatureBytes = nacl.sign.detached(messageBytes, keypair.secretKey);
      const signature = bs58.encode(signatureBytes);

      // 3. Get JWT token
      const authResponse = await axios.post(`${this.API_BASE_URL}/auth/verify-signature`, {
        walletAddress,
        signature,
        message,
      });

      const jwtToken = authResponse.data.token;

      // 4. Create coin with the JWT token
      const formData = new FormData();
      
      // Add form fields
      const imageResponse = await axios.get('https://ipfs.io/ipfs/QmVRU8wu7i9b7yR7dsc98jNchmchZiuRRbK66BMj9YmnfG', {
        responseType: 'arraybuffer'
      });
      formData.append('image', Buffer.from(imageResponse.data), {
        filename: 'token-image.jpg',
        contentType: 'image/jpeg'
      });

      formData.append('name', name);
      formData.append('symbol', symbol);
      formData.append('description', `${name} is a community-driven token.`);
      formData.append('personality', 'Friendly and helpful');
      formData.append('instruction', 'Respond politely to all queries about the token');
      formData.append('knowledge', 'Basic cryptocurrency knowledge');
      formData.append('twitter', symbol.toLowerCase());
      formData.append('telegram', `${symbol.toLowerCase()}_group`);
      formData.append('website', `https://${symbol.toLowerCase()}.com`);

      this.logger.log('Attempting to create coin with the following details:');
      this.logger.log(`Name: ${name}`);
      this.logger.log(`Symbol: ${symbol}`);
      this.logger.log(`JWT Token: ${jwtToken.substring(0, 10)}...`); // Log only the first 10 characters for security

      const createCoinResponse = await axios.post(
        `${this.API_BASE_URL}/coin/create`,
        formData,
        {
          headers: {
            ...formData.getHeaders(),
            Authorization: `Bearer ${jwtToken}`,
          },
        }
      );

      this.logger.log(`Coin created successfully: ${JSON.stringify(createCoinResponse.data)}`);
      return true;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        this.logger.error("API Error:", {
          status: error.response?.status,
          data: error.response?.data,
          message: error.response?.data?.message || error.message,
        });
        if (error.response?.data?.data) {
          const decodedData = Buffer.from(error.response.data.data).toString('utf-8');
          this.logger.error('Decoded error data:', decodedData);
        }
      } else {
        this.logger.error("Error creating coin:", error);
      }
      return false;
    }
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
            const tokenDetails = await this.analyzeTokenDetails(tweet.text);
            if (tokenDetails) {
              this.logger.log(`✅ Token details extracted - Name: ${tokenDetails.name}, Symbol: ${tokenDetails.symbol}`);
              
              // Attempt to create the coin
              const coinCreated = await this.createCoin(tokenDetails.name, tokenDetails.symbol);
              
              let replyText: string;
              if (coinCreated) {
                replyText = `Great news! Your token ${tokenDetails.name} (${tokenDetails.symbol}) has been created successfully. 🎉`;
              } else {
                replyText = `I'm sorry, but there was an issue creating your token ${tokenDetails.name} (${tokenDetails.symbol}). Please try again later.`;
              }
              
              this.logger.log(`💬 Attempting to reply with: "${replyText}"`);

              if (await this.replyToTweet(tweet.id, replyText)) {
                this.repliesToday++;
                this.respondedTweets.add(tweet.id);
                this.logger.log(`✅ Successfully replied to token request tweet ${tweet.id}`);
                this.logger.log(`Current reply count: ${this.repliesToday}/17`);
              } else {
                this.logger.error(`❌ Failed to reply to tweet ${tweet.id}`);
              }
            } else {
              this.logger.log('⚠️ Could not extract token details from tweet');
              // Handle the case where token details couldn't be extracted
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
