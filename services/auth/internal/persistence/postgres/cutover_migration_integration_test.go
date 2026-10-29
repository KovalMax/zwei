package postgres

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestV2CutoverMigrationRerun(t *testing.T) {
	url := os.Getenv("ZWEI_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set ZWEI_TEST_DATABASE_URL for PostgreSQL integration")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	schema := "cutover_" + uuid.New().String()[:8]
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err = conn.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		t.Fatal(err)
	}
	defer conn.Exec(ctx, "DROP SCHEMA "+identifier+" CASCADE")
	if _, err = conn.Exec(ctx, "SET search_path TO "+identifier); err != nil {
		t.Fatal(err)
	}
	_, err = conn.Exec(ctx, `CREATE TABLE schema_migrations(version text PRIMARY KEY); CREATE TABLE users(id int PRIMARY KEY, session_version bigint NOT NULL); CREATE TABLE sessions(id int PRIMARY KEY, revoked_at timestamptz); INSERT INTO users VALUES (1, 7); INSERT INTO sessions VALUES (1, NULL)`)
	if err != nil {
		t.Fatal(err)
	}
	migration, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "..", "migrations", "0024_v2_session_cutover.sql"))
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if _, err = conn.Exec(ctx, string(migration)); err != nil {
			t.Fatal(err)
		}
		var version, markers int
		var revoked bool
		if err = conn.QueryRow(ctx, `SELECT (SELECT session_version FROM users WHERE id=1), (SELECT count(*) FROM schema_migrations WHERE version='0024_v2_session_cutover'), (SELECT revoked_at IS NOT NULL FROM sessions WHERE id=1)`).Scan(&version, &markers, &revoked); err != nil {
			t.Fatal(err)
		}
		if version != 8 || markers != 1 || !revoked {
			t.Fatalf("run %d: version=%d markers=%d revoked=%v", i, version, markers, revoked)
		}
		if i == 0 {
			if _, err = conn.Exec(ctx, `INSERT INTO sessions VALUES (2, NULL)`); err != nil {
				t.Fatal(err)
			}
		}
	}
	var newRevoked bool
	if err = conn.QueryRow(ctx, `SELECT revoked_at IS NOT NULL FROM sessions WHERE id=2`).Scan(&newRevoked); err != nil || newRevoked {
		t.Fatalf("rerun revoked new session: %v, %v", newRevoked, err)
	}
}

func TestPushCutoverMigrationFreshAndPreviouslyApplied(t *testing.T) {
	url := os.Getenv("ZWEI_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set ZWEI_TEST_DATABASE_URL for PostgreSQL integration")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	for _, alreadyApplied := range []bool{false, true} {
		schema := "push_cutover_" + uuid.New().String()[:8]
		identifier := pgx.Identifier{schema}.Sanitize()
		if _, err = conn.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
			t.Fatal(err)
		}
		defer conn.Exec(ctx, "DROP SCHEMA "+identifier+" CASCADE")
		if _, err = conn.Exec(ctx, "SET search_path TO "+identifier); err != nil {
			t.Fatal(err)
		}
		if _, err = conn.Exec(ctx, `CREATE TABLE schema_migrations(version text PRIMARY KEY); CREATE TABLE users(id int PRIMARY KEY, session_version bigint NOT NULL); CREATE TABLE sessions(id int PRIMARY KEY, revoked_at timestamptz); CREATE TABLE push_subscriptions(id int PRIMARY KEY); INSERT INTO users VALUES (1, 7); INSERT INTO sessions VALUES (1, NULL); INSERT INTO push_subscriptions VALUES (1)`); err != nil {
			t.Fatal(err)
		}
		read := func(name string) string {
			b, e := os.ReadFile(filepath.Join("..", "..", "..", "..", "..", "migrations", name))
			if e != nil {
				t.Fatal(e)
			}
			return string(b)
		}
		cutover, push := read("0024_v2_session_cutover.sql"), read("0027_v2_push_cutover.sql")
		if alreadyApplied {
			if _, err = conn.Exec(ctx, cutover); err != nil {
				t.Fatal(err)
			}
		}
		for _, migration := range []string{cutover, push} {
			if _, err = conn.Exec(ctx, migration); err != nil {
				t.Fatal(err)
			}
		}
		var count int
		if err = conn.QueryRow(ctx, `SELECT count(*) FROM push_subscriptions`).Scan(&count); err != nil || count != 0 {
			t.Fatalf("alreadyApplied=%v count=%d err=%v", alreadyApplied, count, err)
		}
		if _, err = conn.Exec(ctx, `INSERT INTO push_subscriptions VALUES (2)`); err != nil {
			t.Fatal(err)
		}
		for _, migration := range []string{cutover, push} {
			if _, err = conn.Exec(ctx, migration); err != nil {
				t.Fatal(err)
			}
		}
		var version, markers int
		if err = conn.QueryRow(ctx, `SELECT (SELECT count(*) FROM push_subscriptions), (SELECT session_version FROM users WHERE id=1), (SELECT count(*) FROM schema_migrations WHERE version='0027_v2_push_cutover')`).Scan(&count, &version, &markers); err != nil || count != 1 || version != 8 || markers != 1 {
			t.Fatalf("rerun: count=%d version=%d markers=%d err=%v", count, version, markers, err)
		}
	}
}
