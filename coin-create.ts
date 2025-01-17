import { Keypair } from "@solana/web3.js";
import * as nacl from "tweetnacl";
import { encodeUTF8, decodeUTF8 } from "tweetnacl-util";
import bs58 from "bs58";
import axios from "axios";
import * as fs from 'fs';
import * as path from 'path';

const API_BASE_URL = "https://api.cybers.app/v1";

async function testCreateCoin() {
  // 1. Setup your wallet (using a dummy keypair for testing)
  const keypair = Keypair.generate(); // Generate a new keypair for testing
  const walletAddress = keypair.publicKey.toString();

  try {
    // 2. Create and sign the authentication message
    const message = "Sign in to Cyber";
    const messageBytes = decodeUTF8(message);
    const signatureBytes = nacl.sign.detached(messageBytes, keypair.secretKey);
    const signature = bs58.encode(signatureBytes);

    console.log("Wallet Address:", walletAddress);
    console.log("Signature:", signature);
    console.log("Message:", message);

    // 3. Get JWT token
    const authResponse = await axios.post(`${API_BASE_URL}/auth/verify-signature`, {
      walletAddress,
      signature,
      message,
    });

    const jwtToken = authResponse.data.token;
    console.log("Authentication successful, JWT token received");

    // 4. Create coin with the JWT token
    const formData = new FormData();
    
    // Add a dummy image file
    const dummyImagePath = path.join(__dirname, 'dummy.jpg');
    fs.writeFileSync(dummyImagePath, 'dummy image data');
    
    formData.append('image', new Blob([fs.readFileSync(dummyImagePath)], { type: 'image/jpeg' }), 'dummy.jpg');
    formData.append('name', 'TestCoin');
    formData.append('symbol', 'TEST');
    formData.append('description', 'This is a test coin');
    formData.append('personality', 'Friendly and helpful');
    formData.append('instruction', 'Respond politely to all queries');
    formData.append('knowledge', 'Basic cryptocurrency knowledge');
    formData.append('twitter', 'testcoin');
    formData.append('telegram', 'testcoin_group');
    formData.append('website', 'https://testcoin.com');

    const createCoinResponse = await axios.post(
      `${API_BASE_URL}/coin/create`,
      formData,
      {
        headers: {
          'Content-Type': 'multipart/form-data',
          Authorization: `Bearer ${jwtToken}`,
        },
      }
    );

    console.log("Coin created successfully:", createCoinResponse.data);

    // Clean up the dummy image file
    fs.unlinkSync(dummyImagePath);
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error("API Error:", {
        status: error.response?.status,
        data: error.response?.data,
      });
    } else {
      console.error("Error:", error);
    }
  }
}

// Run the test
testCreateCoin();
