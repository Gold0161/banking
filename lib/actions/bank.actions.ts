"use server";

import {
  ACHClass,
  CountryCode,
  TransferAuthorizationCreateRequest,
  TransferCreateRequest,
  TransferNetwork,
  TransferType,
} from "plaid";
import { z } from 'zod';

import { plaidClient } from "../plaid";
import { parseStringify } from "../utils";
import {
  PLAID_COUNTRY_CODES_US,
  TRANSACTION_TYPE_DEBIT,
  TRANSACTION_TYPE_CREDIT,
} from "@/constants";

import { getTransactionsByBankId } from "./transaction.actions";
import { getBanks, getBank } from "./user.actions";

// Get multiple bank accounts
const GetAccountsPropsSchema = z.object({
  userId: z.string().min(1, "User ID cannot be empty"),
});

export const getAccounts = async (props: getAccountsProps) => {
  try {
    GetAccountsPropsSchema.parse(props);
    const { userId } = props;
    // get banks from db
    const banks = await getBanks({ userId }); // This userId is now validated

    const accounts = await Promise.all(
      banks?.map(async (bank: Bank) => {
        // get each account info from plaid
        const accountsResponse = await plaidClient.accountsGet({
          access_token: bank.accessToken,
        });
        const accountData = accountsResponse.data.accounts[0];

        // get institution info from plaid
        const institution = await getInstitution({
          institutionId: accountsResponse.data.item.institution_id!,
        });

        const account = {
          id: accountData.account_id,
          availableBalance: accountData.balances.available!,
          currentBalance: accountData.balances.current!,
          institutionId: institution.institution_id,
          name: accountData.name,
          officialName: accountData.official_name,
          mask: accountData.mask!,
          type: accountData.type as string,
          subtype: accountData.subtype! as string,
          appwriteItemId: bank.$id,
          sharaebleId: bank.shareableId,
        };

        return account;
      })
    );

    const totalBanks = accounts.length;
    const totalCurrentBalance = accounts.reduce((total, account) => {
      return total + account.currentBalance;
    }, 0);

    return parseStringify({ data: accounts, totalBanks, totalCurrentBalance });
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('Validation error in getAccounts:', error.flatten().fieldErrors);
      throw new Error('Invalid input for getAccounts.');
    }
    console.error("An error occurred while getting the accounts:", error);
    // Consider if errors from getBanks or plaidClient.accountsGet should be specifically handled
    throw new Error("Failed to get accounts");
  }
};

// Get one bank account
const GetAccountPropsSchema = z.object({
  appwriteItemId: z.string().min(1, "Appwrite Item ID cannot be empty"),
});

export const getAccount = async (props: getAccountProps) => {
  try {
    GetAccountPropsSchema.parse(props);
    const { appwriteItemId } = props;

    // get bank from db
    const bank = await getBank({ documentId: appwriteItemId }); // This appwriteItemId is now validated

    // get account info from plaid
    const accountsResponse = await plaidClient.accountsGet({
      access_token: bank.accessToken,
    });
    const accountData = accountsResponse.data.accounts[0];

    // get transfer transactions from appwrite
    const transferTransactionsData = await getTransactionsByBankId({
      bankId: bank.$id,
    });

    const transferTransactions = transferTransactionsData.documents.map(
      (transferData: Transaction) => ({
        id: transferData.$id,
        name: transferData.name!,
        amount: transferData.amount!,
        date: transferData.$createdAt,
        paymentChannel: transferData.channel,
        category: transferData.category,
        type: transferData.senderBankId === bank.$id ? TRANSACTION_TYPE_DEBIT : TRANSACTION_TYPE_CREDIT,
      })
    );

    // get institution info from plaid
    const institution = await getInstitution({
      institutionId: accountsResponse.data.item.institution_id!,
    });

    const transactions = await getTransactions({
      accessToken: bank?.accessToken,
    });

    const account = {
      id: accountData.account_id,
      availableBalance: accountData.balances.available!,
      currentBalance: accountData.balances.current!,
      institutionId: institution.institution_id,
      name: accountData.name,
      officialName: accountData.official_name,
      mask: accountData.mask!,
      type: accountData.type as string,
      subtype: accountData.subtype! as string,
      appwriteItemId: bank.$id,
    };

    // sort transactions by date such that the most recent transaction is first
      const allTransactions = [...transactions, ...transferTransactions].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );

    return parseStringify({
      data: account,
      transactions: allTransactions,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('Validation error in getAccount:', error.flatten().fieldErrors);
      throw new Error('Invalid input for getAccount.');
    }
    console.error("An error occurred while getting the account:", error);
    // Consider if errors from getBank, plaidClient.accountsGet, getTransactionsByBankId, getInstitution, getTransactions should be specifically handled
    throw new Error("Failed to get account details");
  }
};

// Get bank info
const GetInstitutionPropsSchema = z.object({
  institutionId: z.string().min(1, "Institution ID cannot be empty"),
});

export const getInstitution = async (props: getInstitutionProps) => {
  try {
    GetInstitutionPropsSchema.parse(props);
    const { institutionId } = props;

    const institutionResponse = await plaidClient.institutionsGetById({
      institution_id: institutionId, // This institutionId is now validated
      country_codes: [PLAID_COUNTRY_CODES_US] as CountryCode[],
    });

    const intitution = institutionResponse.data.institution;

    return parseStringify(intitution);
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('Validation error in getInstitution:', error.flatten().fieldErrors);
      throw new Error('Invalid input for getInstitution.');
    }
    console.error("An error occurred while getting the institution:", error);
    throw new Error("Failed to get institution information");
  }
};

// Get transactions
const GetTransactionsPropsSchema = z.object({
  accessToken: z.string().min(1, "Access token cannot be empty"),
});

export const getTransactions = async (props: getTransactionsProps) => {
  let hasMore = true;
  let transactions: any = [];

  try {
    GetTransactionsPropsSchema.parse(props);
    const { accessToken } = props;

    // Iterate through each page of new transaction updates for item
    while (hasMore) {
      const response = await plaidClient.transactionsSync({
        access_token: accessToken, // This accessToken is now validated
      });

      const data = response.data;

      transactions = response.data.added.map((transaction) => ({
        id: transaction.transaction_id,
        name: transaction.name,
        paymentChannel: transaction.payment_channel,
        type: transaction.payment_channel,
        accountId: transaction.account_id,
        amount: transaction.amount,
        pending: transaction.pending,
        category: transaction.category ? transaction.category[0] : "",
        date: transaction.date,
        image: transaction.logo_url,
      }));

      hasMore = data.has_more;
    }

    return parseStringify(transactions);
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('Validation error in getTransactions:', error.flatten().fieldErrors);
      throw new Error('Invalid input for getTransactions.');
    }
    console.error("An error occurred while getting the transactions:", error);
    throw new Error("Failed to get transactions");
  }
};