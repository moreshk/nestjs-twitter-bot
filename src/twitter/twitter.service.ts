/* eslint-disable @typescript-eslint/no-unused-vars */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
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
import * as fs from 'fs/promises';
import * as path from 'path';
import * as fsSync from 'fs';

@Injectable()
export class TwitterService implements OnModuleInit {
  private readonly logger = new Logger(TwitterService.name);
  private readonly twitterClient: TwitterApi;
  private readonly openAiClient: OpenAI;
  private readonly API_BASE_URL = "https://api.cybers.app/v1";
  private respondedTweets = new Set<string>();
  private repliesToday = 0;
  private lastReset = new Date();
  private lastProcessedTweetId: string | null = null;
  private isFirstRun = true;
  private readonly storageFile: string;

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

    // Create data directory path
    const dataDir = path.join(process.cwd(), 'data');
    this.storageFile = path.join(dataDir, 'processed_tweets.json');
    
    // Ensure data directory exists
    if (!fsSync.existsSync(dataDir)) {
      fsSync.mkdirSync(dataDir, { recursive: true });
    }
  }

  async onModuleInit() {
    await this.loadProcessedTweets();
    this.checkMentionsJob(); // Immediate first check
  }

  private async loadProcessedTweets() {
    try {
      const data = await fs.readFile(this.storageFile, 'utf8');
      const storedData = JSON.parse(data);
      this.respondedTweets = new Set(storedData.respondedTweets);
      this.lastProcessedTweetId = storedData.lastProcessedTweetId;
      this.repliesToday = storedData.repliesToday || 0;
      this.lastReset = new Date(storedData.lastReset || new Date());
      this.logger.log('Loaded processed tweets from storage');
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.logger.log('No existing storage file found, starting fresh');
      } else {
        this.logger.error('Error loading processed tweets:', error);
      }
    }
  }

  private async saveProcessedTweets() {
    try {
      const dataToStore = {
        respondedTweets: Array.from(this.respondedTweets),
        lastProcessedTweetId: this.lastProcessedTweetId,
        repliesToday: this.repliesToday,
        lastReset: this.lastReset.toISOString(),
      };
      await fs.writeFile(this.storageFile, JSON.stringify(dataToStore, null, 2));
      this.logger.log('Saved processed tweets to storage');
    } catch (error) {
      this.logger.error('Error saving processed tweets:', error);
    }
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
        model: 'gpt-4',
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
      this.logger.log('\nTweet Analysis:');
      this.logger.log(`Tweet: ${tweetText}`);
      this.logger.log(`Decision: ${decision}`);
      return decision === 'YES';
    } catch (error) {
      this.logger.error('Error analyzing tweet intent:', error);
      return false;
    }
  }

  private async analyzeTokenDetails(tweetText: string): Promise<{ name: string; symbol: string } | null> {
    try {
      const response = await this.openAiClient.chat.completions.create({
        model: 'gpt-4',
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

      const cleanedContent = response.choices[0].message.content
        .trim()
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();

      const result = JSON.parse(cleanedContent);
      if (!result.name || !result.symbol) {
        return null;
      }

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

  private async createCoin(name: string, symbol: string): Promise<{ success: boolean; mintAddress?: string }> {
    try {
      // Use private key from environment variable
      const privateKey = bs58.decode(this.configService.get<string>('WALLET_PRIVATE_KEY'));
      const keypair = Keypair.fromSecretKey(privateKey);
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
      const dummyImageBuffer = Buffer.from('dummy image data');
      formData.append('image', dummyImageBuffer, {
        filename: 'dummy.jpg',
        contentType: 'image/jpeg'
      });

      // Ensure name and symbol are within database limits
      name = name.slice(0, 64);
      symbol = symbol.slice(0, 10);

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
      this.logger.log(`JWT Token: ${jwtToken.substring(0, 10)}...`);

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
      return { 
        success: true, 
        mintAddress: createCoinResponse.data.mintAddress 
      };
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
      return { success: false };
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

          if (tweet.author_id === userId) {
            this.logger.log('⚠️ Tweet is from ourselves, skipping...');
            continue;
          }

          if (this.respondedTweets.has(tweet.id)) {
            this.logger.log('⚠️ Already responded to this tweet, skipping...');
            continue;
          }

          const isReplyToHandledTweet = mentions.data.some(
            (t) => tweet.text.includes(t.id) && this.respondedTweets.has(t.id),
          );
          if (isReplyToHandledTweet) {
            this.logger.log('⚠️ Tweet is a reply to an already handled tweet, skipping...');
            this.respondedTweets.add(tweet.id);
            continue;
          }

          if (this.repliesToday >= 17) {
            this.logger.log('⚠️ Hit reply limit during processing. Waiting for next day...');
            break;
          }

          this.logger.log('🔍 Analyzing tweet intent...');
          const isTokenRequest = await this.analyzeTokenIntent(tweet.text);
          this.logger.log(`Analysis result: ${isTokenRequest ? 'Token request detected' : 'Not a token request'}`);

          if (isTokenRequest) {
            const tokenDetails = await this.analyzeTokenDetails(tweet.text);
            if (tokenDetails) {
              this.logger.log(`✅ Token details extracted - Name: ${tokenDetails.name}, Symbol: ${tokenDetails.symbol}`);
              
              const coinResult = await this.createCoin(tokenDetails.name, tokenDetails.symbol);
              
              let replyText: string;
              if (coinResult.success && coinResult.mintAddress) {
                const tokenUrl = `https://beta.cybers.app/token/${coinResult.mintAddress}`;
                replyText = `Great news! Your token ${tokenDetails.name} (${tokenDetails.symbol}) has been created successfully. 🎉\n\nView your token here: ${tokenUrl}`;
              } else {
                replyText = `I'm sorry, but there was an issue creating your token ${tokenDetails.name} (${tokenDetails.symbol}). Please try again later.`;
              }
              
              this.logger.log(`💬 Attempting to reply with: "${replyText}"`);

              if (await this.replyToTweet(tweet.id, replyText)) {
                this.repliesToday++;
                this.respondedTweets.add(tweet.id);
                await this.saveProcessedTweets(); // Save after processing each tweet
                this.logger.log(`✅ Successfully replied to token request tweet ${tweet.id}`);
                this.logger.log(`Current reply count: ${this.repliesToday}/17`);
              } else {
                this.logger.error(`❌ Failed to reply to tweet ${tweet.id}`);
              }
            } else {
              this.logger.log('⚠️ Could not extract token details from tweet');
            }
          } else {
            this.logger.log('⏭️ Not a token request, marking as processed and skipping...');
            this.respondedTweets.add(tweet.id);
            await this.saveProcessedTweets(); // Save after processing each tweet
          }
        }
      }

      this.logger.log('\n=== Job completed, waiting 15 minutes before next check... ===');
    } catch (error) {
      this.logger.error('\n❌ An error occurred:', error);
    }
  }
}
