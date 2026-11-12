import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.ts";

export type Db = PrismaClient;
/** The client inside `db.$transaction(async (tx) => ...)`. */
export type Tx = Parameters<Parameters<Db["$transaction"]>[0]>[0];

export function createDb(connectionString: string): Db {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}
