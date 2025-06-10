"use server";

import { Client, Account, Databases, Users } from "node-appwrite";
import { cookies } from "next/headers";
import { APPWRITE_SESSION_COOKIE } from "@/constants";

// Helper function to get and validate environment variables
const getRequiredEnvVariable = (key: string): string => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

export async function createSessionClient() {
  const endpoint = getRequiredEnvVariable('NEXT_PUBLIC_APPWRITE_ENDPOINT');
  const projectId = getRequiredEnvVariable('NEXT_PUBLIC_APPWRITE_PROJECT');

  const client = new Client()
    .setEndpoint(endpoint)
    .setProject(projectId);

  const session = cookies().get(APPWRITE_SESSION_COOKIE);

  if (!session || !session.value) {
    throw new Error("No session");
  }

  client.setSession(session.value);

  return {
    get account() {
      return new Account(client);
    },
  };
}

export async function createAdminClient() {
  const endpoint = getRequiredEnvVariable('NEXT_PUBLIC_APPWRITE_ENDPOINT');
  const projectId = getRequiredEnvVariable('NEXT_PUBLIC_APPWRITE_PROJECT');
  const apiKey = getRequiredEnvVariable('NEXT_APPWRITE_KEY');

  const client = new Client()
    .setEndpoint(endpoint)
    .setProject(projectId)
    .setKey(apiKey);

  return {
    get account() {
      return new Account(client);
    },
    get database() {
      return new Databases(client);
    },
    get user() {
      return new Users(client);
    }
  };
}

