-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "run_status" AS ENUM ('running', 'stopping', 'parked', 'resumed', 'completed', 'cancelled', 'failed', 'orphaned');

-- CreateTable
CREATE TABLE "threads" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL DEFAULT '',
    "agent_id" TEXT NOT NULL,
    "title" TEXT,
    "last_seq" BIGINT NOT NULL DEFAULT 0,
    "run_count" INTEGER NOT NULL DEFAULT 0,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "settings_version" INTEGER NOT NULL DEFAULT 0,
    "applied_settings_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runs" (
    "id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "status" "run_status" NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'chat',
    "input" JSONB NOT NULL,
    "lease_holder" TEXT,
    "lease_expires_at" TIMESTAMPTZ(3),
    "stop_requested_at" TIMESTAMPTZ(3),
    "waiting_for" TEXT,
    "waiting_payload" JSONB,
    "resumes_run_id" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "thread_id" TEXT NOT NULL,
    "seq" BIGINT NOT NULL,
    "run_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("thread_id","seq")
);

-- CreateTable
CREATE TABLE "thread_messages" (
    "thread_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,

    CONSTRAINT "thread_messages_pkey" PRIMARY KEY ("thread_id","message_id")
);

-- CreateIndex
CREATE INDEX "threads_owner_id_updated_at_idx" ON "threads"("owner_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "runs_status_lease_expires_at_idx" ON "runs"("status", "lease_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "runs_thread_id_number_key" ON "runs"("thread_id", "number");

-- CreateIndex
CREATE INDEX "events_thread_id_type_seq_idx" ON "events"("thread_id", "type", "seq");

-- CreateIndex
CREATE INDEX "events_run_id_seq_idx" ON "events"("run_id", "seq");

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "thread_messages" ADD CONSTRAINT "thread_messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- At most one run per thread may be running or stopping. Prisma's schema
-- language has no partial unique index, so it is written by hand. This is the
-- backstop behind the checks in createRun: even a bug there cannot produce two
-- drivers for one thread.
CREATE UNIQUE INDEX "runs_one_active_per_thread" ON "runs"("thread_id") WHERE "status" IN ('running', 'stopping');
