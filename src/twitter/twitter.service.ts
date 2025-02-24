/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-unused-vars */
//Dummy 1
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TwitterApi } from 'twitter-api-v2';
import { ConfigService } from '@nestjs/config';
import { OpenAI } from 'openai';
import { Keypair } from '@solana/web3.js';
import * as nacl from 'tweetnacl';
import { encodeUTF8, decodeUTF8 } from 'tweetnacl-util';
import bs58 from 'bs58';
import axios from 'axios';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import FormData = require('form-data');
import * as fs from 'fs/promises';
import * as path from 'path';
import * as fsSync from 'fs';
import * as sharp from 'sharp';
import { Pool } from 'pg';

@Injectable()
export class TwitterService implements OnModuleInit {
  private readonly logger = new Logger(TwitterService.name);
  private readonly twitterClient: TwitterApi;
  private readonly openAiClient: OpenAI;
  private readonly API_BASE_URL = 'https://api.heyhal.xyz/v1';
  private readonly TWITTER_USER_ID: string;
  private repliesToday = 0;
  private lastReset = new Date();
  private isFirstRun = true;
  private readonly MAX_REPLIES_PER_DAY = 100;
  private pool: Pool;

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

    this.TWITTER_USER_ID = configService.get('TWITTER_USER_ID');

    this.logger.log('Twitter bot service initialized');

    // Initialize database connection with SSL disabled for local development
    this.pool = new Pool({
      host: configService.get('DB_HOST'),
      database: configService.get('DB_NAME'),
      user: configService.get('DB_USERNAME'),
      password: configService.get('DB_PASSWORD'),
      port: parseInt(configService.get('DB_PORT')),
      ssl: {
        rejectUnauthorized: false // This allows connecting without SSL verification
      }
    });
  }

  async onModuleInit() {
    await this.ensureTableExists();
    this.checkMentionsJob(); // Keep this immediate first check
  }

  private async ensureTableExists() {
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS processed_tweets (
          tweet_id VARCHAR(255) PRIMARY KEY,
          processed_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
        )
      `);
      this.logger.log('Processed tweets table verified/created');
    } catch (error) {
      this.logger.error('Error ensuring table exists:', error);
    }
  }

  private async isTweetProcessed(tweetId: string): Promise<boolean> {
    try {
      const result = await this.pool.query(
        'SELECT EXISTS(SELECT 1 FROM processed_tweets WHERE tweet_id = $1)',
        [tweetId]
      );
      return result.rows[0].exists;
    } catch (error) {
      this.logger.error('Error checking processed tweet:', error);
      return false;
    }
  }

  private async markTweetAsProcessed(tweetId: string): Promise<void> {
    try {
      await this.pool.query(
        'INSERT INTO processed_tweets (tweet_id) VALUES ($1) ON CONFLICT DO NOTHING',
        [tweetId]
      );
      this.logger.log(`Marked tweet ${tweetId} as processed`);
    } catch (error) {
      this.logger.error('Error marking tweet as processed:', error);
    }
  }

  private async getLastProcessedTweetId(): Promise<string | null> {
    try {
      const result = await this.pool.query(`
        SELECT tweet_id 
        FROM processed_tweets 
        ORDER BY processed_at DESC 
        LIMIT 1
      `);
      return result.rows[0]?.tweet_id || null;
    } catch (error) {
      this.logger.error('Error getting last processed tweet:', error);
      return null;
    }
  }

  private async checkMentions(userId: string, options: any): Promise<any> {
    try {
      // Increase max results to catch more mentions
      options.max_results = 20;

      // Add required fields for media detection
      options['tweet.fields'] = [
        'created_at',
        'text',
        'author_id',
        'attachments',
      ];
      options['expansions'] = [
        'author_id',
        'attachments.media_keys',
      ];
      options['media.fields'] = ['type', 'url', 'media_key'];

      // Get mentions with pagination
      const mentions = await this.twitterClient.v2.userMentionTimeline(
        userId,
        {
          ...options,
          start_time: new Date(Date.now() - 7 * 60 * 1000).toISOString(), // Last 7 minutes
        },
      );

      if (mentions.data && Array.isArray(mentions.data.data)) {
        this.logger.log(
          `Found ${mentions.data.data.length} mentions in latest check`,
        );
      } else {
        this.logger.log('No mentions found');
      }

      return mentions.data;
    } catch (error) {
      if (error.code === 429) {
        // Wait for 2 minutes before next attempt
        await new Promise(resolve => setTimeout(resolve, 120000));
        this.logger.warn('Rate limit reached, waited 2 minutes');
        return null;
      }
      this.logger.error('API Error:', error);
      return null;
    }
  }

  private async replyToTweet(
    tweetId: string,
    replyText: string,
    mediaId?: string
  ): Promise<boolean> {
    try {
      await this.twitterClient.v2.reply(
        replyText,
        tweetId,
        mediaId ? { media: { media_ids: [mediaId] } } : undefined
      );
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
      this.logger.log('\nTweet Analysis:');
      this.logger.log(`Tweet: ${tweetText}`);
      this.logger.log(`Decision: ${decision}`);
      return decision === 'YES';
    } catch (error) {
      this.logger.error('Error analyzing tweet intent:', error);
      return false;
    }
  }

  private async analyzeTokenDetails(
    tweetText: string,
  ): Promise<{ name: string; symbol: string; description?: string } | null> {
    try {
      const response = await this.openAiClient.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content:
              'You are a token analyzer. Extract the token name, symbol, and description from the tweet. Respond with a JSON object containing "name", "symbol", and "description" fields. If only name is found, use it for both name and symbol. Example: {"name": "MyToken", "symbol": "MTK", "description": "A community-driven token for gaming"}. If no description is provided, set it to null. If no valid name/symbol found, respond: {"name": null, "symbol": null, "description": null}. Do not include the words "token" or "coin" in either the name or symbol.',
          },
          {
            role: 'user',
            content: `Extract the token details from this tweet: ${tweetText}`,
          },
        ],
        max_tokens: 300,
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

      // Additional validation to remove 'token' and 'coin' from name and symbol
      const sanitizeName = (str: string) => 
        str.replace(/token|coin/gi, '').trim();

      result.name = sanitizeName(result.name);
      result.symbol = sanitizeName(result.symbol);

      // Return null if name or symbol is empty after sanitization
      if (!result.name || !result.symbol) {
        return null;
      }

      this.logger.log('Token Details Analysis:');
      this.logger.log(`Name: ${result.name}`);
      this.logger.log(`Symbol: ${result.symbol}`);
      this.logger.log(`Description: ${result.description || 'None provided'}`);

      return {
        name: result.name,
        symbol: result.symbol,
        description: result.description || null,
      };
    } catch (error) {
      this.logger.error('Error analyzing token details:', error);
      return null;
    }
  }

  private async downloadImage(url: string): Promise<Buffer> {
    try {
      const response = await axios.get(url, { responseType: 'arraybuffer' });
      return Buffer.from(response.data);
    } catch (error) {
      this.logger.error('Error downloading image:', error);
      throw new Error('Failed to download image');
    }
  }

  private async overlayTextOnImage(imageBuffer: Buffer, mintAddress: string): Promise<Buffer> {
    try {
      // Create a text overlay SVG
      const svgText = `
        <svg width="1000" height="1000">
          <style>
            .text {
              fill: white;
              font-size: 40px;
              font-weight: bold;
              font-family: Arial, sans-serif;
              text-shadow: 2px 2px 5px rgba(0,0,0,0.5);
            }
          </style>
          <text x="50%" y="90%" text-anchor="middle" class="text">${mintAddress}</text>
        </svg>`;

      // Overlay the text on the image
      return await sharp(imageBuffer)
        .resize(1000, 1000, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .composite([
          {
            input: Buffer.from(svgText),
            top: 0,
            left: 0,
          },
        ])
        .jpeg()
        .toBuffer();
    } catch (error) {
      this.logger.error('Error overlaying text on image:', error);
      return imageBuffer; // Return original image if overlay fails
    }
  }

  private async createCoin(
    name: string,
    symbol: string,
    imageBuffer: Buffer,
    tweetAuthorId: string,
    tweetAuthorUsername: string,
    description?: string,
  ): Promise<{ success: boolean; mintAddress?: string }> {
    try {
      // Use private key from environment variable
      const privateKey = bs58.decode(
        this.configService.get<string>('WALLET_PRIVATE_KEY'),
      );
      const keypair = Keypair.fromSecretKey(privateKey);
      const walletAddress = keypair.publicKey.toString();

      // 2. Create and sign the authentication message
      const message = 'Sign in to Cyber';
      const messageBytes = decodeUTF8(message);
      const signatureBytes = nacl.sign.detached(
        messageBytes,
        keypair.secretKey,
      );
      const signature = bs58.encode(signatureBytes);

      // 3. Get JWT token
      const authResponse = await axios.post(
        `${this.API_BASE_URL}/auth/verify-signature`,
        {
          walletAddress,
          signature,
          message,
        },
      );

      const jwtToken = authResponse.data.token;

      // 4. Create coin with the JWT token
      const formData = new FormData();

      // Add image to form data
      formData.append('image', imageBuffer, {
        filename: 'token_image.jpg',
        contentType: 'image/jpeg',
      });

      // Ensure name and symbol are within database limits
      name = name.slice(0, 64);
      symbol = symbol.slice(0, 10);

      formData.append('name', name);
      formData.append('symbol', symbol);
      formData.append('description', description || '');
      formData.append('personality', 'Friendly and helpful');
      formData.append(
        'instruction',
        'Respond politely to all queries about the token',
      );
      formData.append('knowledge', 'Basic cryptocurrency knowledge');
      formData.append('twitter', '');
      formData.append('telegram', '');
      formData.append('website', '');
      formData.append('creatorTwitterUserId', tweetAuthorId);
      formData.append('creatorTwitterUsername', tweetAuthorUsername);
      formData.append('vanityAddress', 'HAL');

      this.logger.log('Attempting to create coin with the following details:');
      this.logger.log(`Name: ${name}`);
      this.logger.log(`Symbol: ${symbol}`);
      this.logger.log(`JWT Token: ${jwtToken.substring(0, 10)}...`);
      this.logger.log(`Vanity Address: HAL`);

      const createCoinResponse = await axios.post(
        `${this.API_BASE_URL}/coin/create`,
        formData,
        {
          headers: {
            ...formData.getHeaders(),
            Authorization: `Bearer ${jwtToken}`,
          },
        },
      );

      this.logger.log(
        `Coin created successfully: ${JSON.stringify(createCoinResponse.data)}`,
      );
      return {
        success: true,
        mintAddress: createCoinResponse.data.mintAddress,
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        this.logger.error('API Error:', {
          status: error.response?.status,
          data: error.response?.data,
          message: error.response?.data?.message || error.message,
        });
        if (error.response?.data?.data) {
          const decodedData = Buffer.from(error.response.data.data).toString(
            'utf-8',
          );
          this.logger.error('Decoded error data:', decodedData);
        }
      } else {
        this.logger.error('Error creating coin:', error);
      }
      return { success: false };
    }
  }

  private async shortenUrl(longUrl: string): Promise<string> {
    try {
      const response = await axios.get('https://is.gd/create.php', {
        params: {
          format: 'json',
          url: longUrl
        }
      });
      return response.data.shorturl;
    } catch (error) {
      this.logger.error('Error shortening URL:', error);
      return longUrl; // Fallback to original URL if shortening fails
    }
  }

  @Cron('*/2 * * * *')
  async checkMentionsJob() {
    try {
      this.logger.log('\n=== Starting mention check job ===');

      // Check if we've hit the daily reply limit
      this.checkAndResetDaily();
      if (this.repliesToday >= this.MAX_REPLIES_PER_DAY) {
        this.logger.log(
          `Daily reply limit reached (${this.MAX_REPLIES_PER_DAY}). Waiting for next day...`
        );
        return;
      }

      const username = this.configService.get('TWITTER_USER_NAME');
      this.logger.log(`Checking mentions for user: ${username}`);

      const userId = this.TWITTER_USER_ID;
      if (!userId) {
        this.logger.error('Twitter user ID not found in environment variables');
        return;
      }

      // this.logger.log(`Found user ID: ${userId}`);
      this.logger.log(
        `Current replies today: ${this.repliesToday}/${this.MAX_REPLIES_PER_DAY}`,
      );

      const mentions = await this.checkMentions(userId, {
        'tweet.fields': ['created_at', 'text', 'author_id'],
        expansions: ['author_id'],
        'user.fields': ['username'],
      });

      if (mentions && mentions.data && Array.isArray(mentions.data)) {
        for (const tweet of mentions.data) {
          this.logger.log('\n--- Processing Tweet ---');
          this.logger.log(`Tweet ID: ${tweet.id}`);
          this.logger.log(`Author ID: ${tweet.author_id}`);
          this.logger.log(`Content: ${tweet.text}`);

          // Check if tweet was already processed
          const isProcessed = await this.isTweetProcessed(tweet.id);
          if (isProcessed) {
            this.logger.log('⚠️ Tweet already processed in database, skipping...');
            continue;
          }

          if (tweet.author_id === userId) {
            this.logger.log('⚠️ Tweet is from ourselves, marking as processed...');
            await this.markTweetAsProcessed(tweet.id);
            continue;
          }

          // Process the tweet and handle response
          const isTokenRequest = await this.analyzeTokenIntent(tweet.text);
          if (isTokenRequest) {
            const tokenDetails = await this.analyzeTokenDetails(tweet.text);
            if (tokenDetails) {
              // Check for image in tweet
              const imageMedia = mentions.includes?.media?.find(
                (media) =>
                  media.type === 'photo' &&
                  tweet.attachments?.media_keys?.includes(media.media_key)
              );

              if (!imageMedia) {
                const replyText = `Please include a suitable image for your token and try your request again! 🖼️`;
                if (await this.replyToTweet(tweet.id, replyText)) {
                  await this.markTweetAsProcessed(tweet.id);
                  this.repliesToday++;
                }
                continue;
              }

              try {
                if (!imageMedia.url) {
                  throw new Error('Image URL not found');
                }

                const imageBuffer = await this.downloadImage(imageMedia.url);
                
                // Upload the image to Twitter
                const mediaId = await this.twitterClient.v1.uploadMedia(imageBuffer, { mimeType: 'image/jpeg' });

                const coinResult = await this.createCoin(
                  tokenDetails.name,
                  tokenDetails.symbol,
                  imageBuffer,
                  tweet.author_id,
                  mentions.includes?.users?.find(
                    (u) => u.id === tweet.author_id,
                  )?.username || '',
                  tokenDetails.description,
                );

                let replyText: string;
                if (coinResult.success && coinResult.mintAddress) {
                  const tokenUrl = `https://heyhal.xyz/token/${coinResult.mintAddress}`;
                  
                  replyText = `Hey Pal, ${tokenDetails.name} (${tokenDetails.symbol}) has been created!\n\n✨ CA: ${coinResult.mintAddress}\n\n🔗 View and claim your token here:\n${tokenUrl}`;
                  if (await this.replyToTweet(tweet.id, replyText)) {
                    await this.markTweetAsProcessed(tweet.id);
                    this.repliesToday++;
                  }
                }
              } catch (error) {
                this.logger.error('Error creating coin:', error);
              }
            }
          } else {
            this.logger.log('📝 Not a token request, marking as processed');
            await this.markTweetAsProcessed(tweet.id);
          }
        }
      } else {
        this.logger.log('No valid mentions data found');
      }
    } catch (error) {
      this.logger.error('Error checking mentions:', error);
    }
  }
}