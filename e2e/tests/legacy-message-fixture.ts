import {Client} from 'pg';

// This helper is runner-only. It cannot target a configurable host or database.
export function fixtureDatabaseConfig(env: NodeJS.ProcessEnv) {
  if (env.E2E_FIXTURE_DATABASE !== 'messenger_test' || !env.E2E_FIXTURE_DB_USER || !env.E2E_FIXTURE_DB_PASSWORD) {
    throw new Error('Legacy message fixture requires the isolated messenger_test database');
  }
  return {
    host: 'database', port: 5432, database: 'messenger_test',
    user: env.E2E_FIXTURE_DB_USER, password: env.E2E_FIXTURE_DB_PASSWORD,
    connectionTimeoutMillis: 5000,
  };
}

export async function markPersistedMessageAsLegacySticker(conversationID: string, messageID: string): Promise<void> {
  const client = new Client(fixtureDatabaseConfig(process.env));
  try {
    await client.connect();
    const result = await client.query(
      `UPDATE messages SET content_type = 'sticker'
       WHERE current_database() = 'messenger_test' AND conversation_id = $1 AND id = $2 AND content_type = 'text'`,
      [conversationID, messageID],
    );
    if (result.rowCount !== 1) throw new Error('Legacy sticker fixture did not update exactly one text message');
  } finally {
    await client.end();
  }
}
