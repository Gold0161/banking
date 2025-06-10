"use server";

import { ID, Query } from "node-appwrite";
import { z } from 'zod';
import { createAdminClient } from "../appwrite";
import { parseStringify } from "../utils";
import {
  TRANSACTION_CHANNEL_ONLINE,
  TRANSACTION_CATEGORY_TRANSFER,
} from "@/constants";

const {
  APPWRITE_DATABASE_ID: DATABASE_ID,
  APPWRITE_TRANSACTION_COLLECTION_ID: TRANSACTION_COLLECTION_ID,
} = process.env;

// Helper function to get and validate environment variables
const getRequiredEnvVariable = (key: string): string => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

// Zod schema for CreateTransactionProps
const CreateTransactionPropsSchema = z.object({
  name: z.string().optional(),
  amount: z.number().positive("Transaction amount must be positive"),
  senderId: z.string().min(1, "Sender ID cannot be empty"),
  senderBankId: z.string().min(1, "Sender Bank ID cannot be empty"),
  receiverId: z.string().min(1, "Receiver ID cannot be empty"),
  receiverBankId: z.string().min(1, "Receiver Bank ID cannot be empty"),
  email: z.string().email("Invalid email address for transaction"),
});

export const createTransaction = async (transaction: CreateTransactionProps) => {
  try {
    CreateTransactionPropsSchema.parse(transaction);

    const databaseId = getRequiredEnvVariable('APPWRITE_DATABASE_ID');
    const transactionCollectionId = getRequiredEnvVariable('APPWRITE_TRANSACTION_COLLECTION_ID');
    const { database } = await createAdminClient();

    const newTransaction = await database.createDocument(
      databaseId,
      transactionCollectionId,
      ID.unique(),
      {
        channel: TRANSACTION_CHANNEL_ONLINE,
        category: TRANSACTION_CATEGORY_TRANSFER,
        ...transaction
      }
    )

    return parseStringify(newTransaction);
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('Validation error in createTransaction:', error.flatten().fieldErrors);
      throw new Error('Invalid input for createTransaction.');
    }
    console.error("Failed to create transaction:", error);
    if (error instanceof Error && error.message.startsWith('Missing required environment variable')) {
      throw error;
    }
    throw new Error("Error creating transaction");
  }
}

// Zod schema for getTransactionsByBankIdProps
const GetTransactionsByBankIdPropsSchema = z.object({
  bankId: z.string().min(1, "Bank ID cannot be empty"),
});

export const getTransactionsByBankId = async (props: getTransactionsByBankIdProps) => {
  try {
    GetTransactionsByBankIdPropsSchema.parse(props);
    const { bankId } = props;

    const databaseId = getRequiredEnvVariable('APPWRITE_DATABASE_ID');
    const transactionCollectionId = getRequiredEnvVariable('APPWRITE_TRANSACTION_COLLECTION_ID');
    const { database } = await createAdminClient();

    const senderTransactions = await database.listDocuments(
      databaseId,
      transactionCollectionId,
      [Query.equal('senderBankId', bankId)],
    )

    const receiverTransactions = await database.listDocuments(
      databaseId,
      transactionCollectionId,
      [Query.equal('receiverBankId', bankId)],
    );

    const transactions = {
      total: senderTransactions.total + receiverTransactions.total,
      documents: [
        ...senderTransactions.documents, 
        ...receiverTransactions.documents,
      ]
    }

    return parseStringify(transactions);
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('Validation error in getTransactionsByBankId:', error.flatten().fieldErrors);
      throw new Error('Invalid input for getTransactionsByBankId.');
    }
    console.error("Failed to get transactions by bank ID:", error);
    if (error instanceof Error && error.message.startsWith('Missing required environment variable')) {
      throw error;
    }
    throw new Error("Error getting transactions by bank ID");
  }
}