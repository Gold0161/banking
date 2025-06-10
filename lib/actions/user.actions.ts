'use server';

'use server';

import { ID, Query } from "node-appwrite";
import { z } from 'zod';
import { createAdminClient, createSessionClient } from "../appwrite";
import { cookies } from "next/headers";
import { encryptId, extractCustomerIdFromUrl, parseStringify } from "../utils";
import { CountryCode, ProcessorTokenCreateRequest, ProcessorTokenCreateRequestProcessorEnum, Products } from "plaid";

import { plaidClient } from '@/lib/plaid';
import { revalidatePath } from "next/cache";
import { addFundingSource, createDwollaCustomer } from "./dwolla.actions";
import {
  APPWRITE_SESSION_COOKIE,
  APPWRITE_CURRENT_SESSION,
  PLAID_PRODUCTS_AUTH,
  PLAID_COUNTRY_CODES_US,
  PLAID_LANGUAGE_EN,
  DWOLLA_PROCESSOR_NAME,
  COOKIE_PATH_DEFAULT,
  COOKIE_SAMESITE_STRICT,
} from "@/constants";

const {
  APPWRITE_DATABASE_ID: DATABASE_ID,
  APPWRITE_USER_COLLECTION_ID: USER_COLLECTION_ID,
  APPWRITE_BANK_COLLECTION_ID: BANK_COLLECTION_ID,
} = process.env;

// Helper function to get and validate environment variables
const getRequiredEnvVariable = (key: string): string => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

// Zod schema for getUserInfoProps
const GetUserInfoPropsSchema = z.object({
  userId: z.string().min(1, { message: "User ID cannot be empty" }),
});

export const getUserInfo = async (props: getUserInfoProps) => {
  try {
    GetUserInfoPropsSchema.parse(props);
    const { userId } = props;

    const databaseId = getRequiredEnvVariable('APPWRITE_DATABASE_ID');
    const userCollectionId = getRequiredEnvVariable('APPWRITE_USER_COLLECTION_ID');
    const { database } = await createAdminClient();

    const user = await database.listDocuments(
      databaseId,
      userCollectionId,
      [Query.equal('userId', [userId])]
    )

    if (!user.documents || user.documents.length === 0) {
      throw new Error('User not found');
    }
    return parseStringify(user.documents[0]);
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('Validation error in getUserInfo:', error.flatten().fieldErrors);
      // Consider logging specific field errors: error.flatten().fieldErrors
      throw new Error('Invalid input for getUserInfo.');
    }
    console.error('Error getting user info:', error);
    if (error instanceof Error && error.message === 'User not found') {
      throw error;
    }
    if (error instanceof Error && error.message.startsWith('Missing required environment variable')) {
      throw error;
    }
    throw new Error('Failed to retrieve user info');
  }
}

export const signIn = async ({ email, password }: signInProps) => {
  try {
    const { account } = await createAdminClient();
    const session = await account.createEmailPasswordSession(email, password);

    cookies().set(APPWRITE_SESSION_COOKIE, session.secret, {
      path: COOKIE_PATH_DEFAULT,
      httpOnly: true,
      sameSite: COOKIE_SAMESITE_STRICT,
      secure: true,
    });

    const user = await getUserInfo({ userId: session.userId }) 

    if (!user) {
      throw new Error('Failed to retrieve user info after sign in.');
    }

    return parseStringify(user);
  } catch (error) {
    console.error('Error during sign in:', error);
    // Check if it's an error we threw deliberately
    if (error instanceof Error && error.message.startsWith('Failed to retrieve user info')) {
      throw error;
    }
    throw new Error('Sign in failed');
  }
}

export const signUp = async ({ password, ...userData }: SignUpParams) => {
  const { email, firstName, lastName } = userData;
  
  let newUserAccount;

  try {
    const { account, database } = await createAdminClient();

    newUserAccount = await account.create(
      ID.unique(), 
      email, 
      password, 
      `${firstName} ${lastName}`
    );

    if(!newUserAccount) throw new Error('Error creating user')

    const dwollaCustomerUrl = await createDwollaCustomer({
      ...userData,
      type: 'personal'
    })

    if(!dwollaCustomerUrl) throw new Error('Error creating Dwolla customer')

    const dwollaCustomerId = extractCustomerIdFromUrl(dwollaCustomerUrl);

    const databaseId = getRequiredEnvVariable('APPWRITE_DATABASE_ID');
    const userCollectionId = getRequiredEnvVariable('APPWRITE_USER_COLLECTION_ID');

    const newUser = await database.createDocument(
      databaseId,
      userCollectionId,
      ID.unique(),
      {
        ...userData,
        userId: newUserAccount.$id,
        dwollaCustomerId,
        dwollaCustomerUrl
      }
    )

    const session = await account.createEmailPasswordSession(email, password);

    cookies().set(APPWRITE_SESSION_COOKIE, session.secret, {
      path: COOKIE_PATH_DEFAULT,
      httpOnly: true,
      sameSite: COOKIE_SAMESITE_STRICT,
      secure: true,
    });

    return parseStringify(newUser);
  } catch (error) {
    console.error('Error during sign up:', error);
    if (error instanceof Error && (error.message === 'Error creating user' || error.message === 'Error creating Dwolla customer' || error.message.startsWith('Missing required environment variable'))) {
      throw error;
    }
    throw new Error('Sign up failed');
  }
}

export async function getLoggedInUser() {
  try {
    const { account } = await createSessionClient();
    const result = await account.get();

    const user = await getUserInfo({ userId: result.$id})

    if (!user) {
      // getUserInfo will throw an error if it fails, but as a safeguard:
      throw new Error('Failed to retrieve user info for logged in user.');
    }

    return parseStringify(user);
  } catch (error) {
    console.error('Error getting logged in user:', error);
    // If getUserInfo threw an error, re-throw it.
    if (error instanceof Error && error.message.startsWith('Failed to retrieve user info')) {
      throw error;
    }
    // For other errors (e.g., session client issues), return null as per original logic,
    // or decide on a specific error to throw. For now, maintaining null return for non-getUserInfo errors.
    // Consider: throw new Error('Could not retrieve logged in user session');
    return null;
  }
}

export const logoutAccount = async () => {
  try {
    const { account } = await createSessionClient();

    cookies().delete(APPWRITE_SESSION_COOKIE);

    await account.deleteSession(APPWRITE_CURRENT_SESSION);
  } catch (error) {
    console.error('Error logging out:', error);
    throw new Error('Logout failed');
  }
}

// Zod schema for User in createLinkToken
const LinkTokenUserSchema = z.object({
  $id: z.string().min(1, { message: "User $id cannot be empty" }),
  firstName: z.string().min(1, { message: "First name cannot be empty" }), // Assuming min 1 for existing users
  lastName: z.string().min(1, { message: "Last name cannot be empty" }),  // Assuming min 1 for existing users
});

export const createLinkToken = async (user: User) => {
  try {
    LinkTokenUserSchema.parse(user);

    const tokenParams = {
      user: {
        client_user_id: user.$id
      },
      client_name: `${user.firstName} ${user.lastName}`,
      products: [PLAID_PRODUCTS_AUTH] as Products[],
      language: PLAID_LANGUAGE_EN,
      country_codes: [PLAID_COUNTRY_CODES_US] as CountryCode[],
    }

    const response = await plaidClient.linkTokenCreate(tokenParams);

    return parseStringify({ linkToken: response.data.link_token })
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('Validation error in createLinkToken:', error.flatten().fieldErrors);
      throw new Error('Invalid user data for createLinkToken.');
    }
    console.error('Error creating link token:', error);
    throw new Error('Failed to create link token');
  }
}

// Zod schema for createBankAccountProps
const CreateBankAccountPropsSchema = z.object({
  userId: z.string().min(1, { message: "User ID cannot be empty" }),
  bankId: z.string().min(1, { message: "Bank ID cannot be empty" }),
  accountId: z.string().min(1, { message: "Account ID cannot be empty" }),
  accessToken: z.string().min(1, { message: "Access token cannot be empty" }),
  fundingSourceUrl: z.string().url({ message: "Funding source URL must be a valid URL" }),
  shareableId: z.string().min(1, { message: "Shareable ID cannot be empty" }),
});

export const createBankAccount = async (props: createBankAccountProps) => {
  try {
    CreateBankAccountPropsSchema.parse(props);
    const {
      userId,
      bankId,
      accountId,
      accessToken,
      fundingSourceUrl,
      shareableId
    } = props;

    const databaseId = getRequiredEnvVariable('APPWRITE_DATABASE_ID');
    const bankCollectionId = getRequiredEnvVariable('APPWRITE_BANK_COLLECTION_ID');
    const { database } = await createAdminClient();

    const bankAccount = await database.createDocument(
      databaseId,
      bankCollectionId,
      ID.unique(),
      {
        userId,
        bankId,
        accountId,
        accessToken,
        fundingSourceUrl,
        shareableId,
      }
    )

    return parseStringify(bankAccount);
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('Validation error in createBankAccount:', error.flatten().fieldErrors);
      throw new Error('Invalid input for createBankAccount.');
    }
    console.error('Error creating bank account:', error);
    if (error instanceof Error && error.message.startsWith('Missing required environment variable')) {
      throw error;
    }
    throw new Error('Failed to create bank account');
  }
}

// Zod schema for exchangePublicTokenProps
const ExchangePublicTokenPropsSchema = z.object({
  publicToken: z.string().min(1, { message: "Public token cannot be empty" }),
  user: z.object({
    $id: z.string().min(1, { message: "User $id cannot be empty" }),
    dwollaCustomerId: z.string().min(1, { message: "Dwolla Customer ID cannot be empty" }),
    // Include other user fields if they are accessed directly and need validation
  }),
});

export const exchangePublicToken = async (props: exchangePublicTokenProps) => {
  try {
    ExchangePublicTokenPropsSchema.parse(props);
    const { publicToken, user } = props;

    // Exchange public token for access token and item ID
    const response = await plaidClient.itemPublicTokenExchange({
      public_token: publicToken,
    });

    const accessToken = response.data.access_token;
    const itemId = response.data.item_id;
    
    // Get account information from Plaid using the access token
    const accountsResponse = await plaidClient.accountsGet({
      access_token: accessToken,
    });

    const accountData = accountsResponse.data.accounts[0];

    // Create a processor token for Dwolla using the access token and account ID
    const request: ProcessorTokenCreateRequest = {
      access_token: accessToken,
      account_id: accountData.account_id,
      processor: DWOLLA_PROCESSOR_NAME as ProcessorTokenCreateRequestProcessorEnum,
    };

    const processorTokenResponse = await plaidClient.processorTokenCreate(request);
    const processorToken = processorTokenResponse.data.processor_token;

     // Create a funding source URL for the account using the Dwolla customer ID, processor token, and bank name
     const fundingSourceUrl = await addFundingSource({
      dwollaCustomerId: user.dwollaCustomerId,
      processorToken,
      bankName: accountData.name,
    });
    
    // If the funding source URL is not created, throw an error
    if (!fundingSourceUrl) throw new Error('Failed to create funding source');

    // Create a bank account using the user ID, item ID, account ID, access token, funding source URL, and shareableId ID
    await createBankAccount({
      userId: user.$id,
      bankId: itemId,
      accountId: accountData.account_id,
      accessToken,
      fundingSourceUrl,
      shareableId: encryptId(accountData.account_id),
    });

    // Revalidate the path to reflect the changes
    revalidatePath(COOKIE_PATH_DEFAULT);

    // Return a success message
    return parseStringify({
      publicTokenExchange: "complete",
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('Validation error in exchangePublicToken:', error.flatten().fieldErrors);
      throw new Error('Invalid input for exchangePublicToken.');
    }
    console.error("An error occurred while exchanging token:", error);
    if (error instanceof Error && error.message === 'Failed to create funding source') {
      throw error;
    }
    throw new Error('Failed to exchange public token');
  }
}

// Zod schema for getBanksProps
const GetBanksPropsSchema = z.object({
  userId: z.string().min(1, { message: "User ID cannot be empty" }),
});

export const getBanks = async (props: getBanksProps) => {
  try {
    GetBanksPropsSchema.parse(props);
    const { userId } = props;

    const databaseId = getRequiredEnvVariable('APPWRITE_DATABASE_ID');
    const bankCollectionId = getRequiredEnvVariable('APPWRITE_BANK_COLLECTION_ID');
    const { database } = await createAdminClient();

    const banks = await database.listDocuments(
      databaseId,
      bankCollectionId,
      [Query.equal('userId', [userId])]
    )

    return parseStringify(banks.documents);
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('Validation error in getBanks:', error.flatten().fieldErrors);
      throw new Error('Invalid input for getBanks.');
    }
    console.error('Error getting banks:', error);
    if (error instanceof Error && error.message.startsWith('Missing required environment variable')) {
      throw error;
    }
    throw new Error('Failed to retrieve banks');
  }
}

// Zod schema for getBankProps
const GetBankPropsSchema = z.object({
  documentId: z.string().min(1, { message: "Document ID cannot be empty" }),
});

export const getBank = async (props: getBankProps) => {
  try {
    GetBankPropsSchema.parse(props);
    const { documentId } = props;

    const databaseId = getRequiredEnvVariable('APPWRITE_DATABASE_ID');
    const bankCollectionId = getRequiredEnvVariable('APPWRITE_BANK_COLLECTION_ID');
    const { database } = await createAdminClient();

    const bank = await database.listDocuments(
      databaseId,
      bankCollectionId,
      [Query.equal('$id', [documentId])]
    )

    if (!bank.documents || bank.documents.length === 0) {
      throw new Error('Bank not found');
    }

    return parseStringify(bank.documents[0]);
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('Validation error in getBank:', error.flatten().fieldErrors);
      throw new Error('Invalid input for getBank.');
    }
    console.error('Error getting bank:', error);
    if (error instanceof Error && (error.message === 'Bank not found' || error.message.startsWith('Missing required environment variable'))) {
      throw error;
    }
    throw new Error('Failed to retrieve bank');
  }
}

// Zod schema for getBankByAccountIdProps
const GetBankByAccountIdPropsSchema = z.object({
  accountId: z.string().min(1, { message: "Account ID cannot be empty" }),
});

export const getBankByAccountId = async (props: getBankByAccountIdProps) => {
  try {
    GetBankByAccountIdPropsSchema.parse(props);
    const { accountId } = props;

    const databaseId = getRequiredEnvVariable('APPWRITE_DATABASE_ID');
    const bankCollectionId = getRequiredEnvVariable('APPWRITE_BANK_COLLECTION_ID');
    const { database } = await createAdminClient();

    const bank = await database.listDocuments(
      databaseId,
      bankCollectionId,
      [Query.equal('accountId', [accountId])]
    )

    if(bank.total !== 1) {
      throw new Error('Bank not found or multiple banks found for accountId');
    }

    return parseStringify(bank.documents[0]);
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('Validation error in getBankByAccountId:', error.flatten().fieldErrors);
      throw new Error('Invalid input for getBankByAccountId.');
    }
    console.error('Error getting bank by accountId:', error);
    if (error instanceof Error && (error.message.includes('Bank not found') || error.message.startsWith('Missing required environment variable'))) {
      throw error;
    }
    throw new Error('Failed to retrieve bank by accountId');
  }
}