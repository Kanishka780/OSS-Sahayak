import neo4j, { Driver } from 'neo4j-driver';
import * as dotenv from 'dotenv';
dotenv.config();

let driver: Driver | null = null;

export function getNeo4jDriver(): Driver {
  if (driver) return driver;

  const uri = (process.env.NEO4J_URI || 'bolt://localhost:7687').trim();
  const username = (process.env.NEO4J_USERNAME || 'neo4j').trim();
  const password = (process.env.NEO4J_PASSWORD || 'password123').trim();

  driver = neo4j.driver(uri, neo4j.auth.basic(username, password));
  return driver;
}

export async function closeNeo4jDriver(): Promise<void> {
  if (driver) {
    await driver.close();
    driver = null;
  }
}
