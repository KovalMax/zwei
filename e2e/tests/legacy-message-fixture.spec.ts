import {expect, test} from '@playwright/test';
import {fixtureDatabaseConfig} from './legacy-message-fixture';

test('legacy fixture rejects missing and non-test database configuration', () => {
  expect(() => fixtureDatabaseConfig({})).toThrow();
  expect(() => fixtureDatabaseConfig({E2E_FIXTURE_DATABASE: 'messenger_db', E2E_FIXTURE_DB_USER: 'user', E2E_FIXTURE_DB_PASSWORD: 'password'})).toThrow();
  expect(() => fixtureDatabaseConfig({E2E_FIXTURE_DATABASE: 'messenger_test', E2E_FIXTURE_DB_USER: 'user'})).toThrow();
  expect(fixtureDatabaseConfig({E2E_FIXTURE_DATABASE: 'messenger_test', E2E_FIXTURE_DB_USER: 'user', E2E_FIXTURE_DB_PASSWORD: 'password', PGHOST: 'elsewhere', PGDATABASE: 'other'})).toMatchObject({host: 'database', database: 'messenger_test', port: 5432});
});
