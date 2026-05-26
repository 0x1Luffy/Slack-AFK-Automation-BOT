'use strict';

const { Queue, Worker, QueueEvents } = require('bullmq');
const { messages } = require('./messages');

const AUTO_RETURN_JOB = 'auto-return';
const REMINDER_JOB = 'reminder';
const REMINDER_BEFORE_MS = 60 * 1000;

async function sendDm(slackClient, userId, text) {
  const opened = await slackClient.conversations.open({ users: userId });
  const channel = opened.channel && opened.channel.id;
  if (!channel) {
    throw new Error('Slack did not return a DM channel');
  }

  await slackClient.chat.postMessage({ channel, text });
}

function createAfkQueue({ queueName, connection, sessionStore, slackClient, statusManager, logger }) {
  const queue = new Queue(queueName, { connection });
  const queueEvents = new QueueEvents(queueName, { connection: connection.duplicate() });

  const worker = new Worker(
    queueName,
    async (job) => {
      const { userId, expiresAt } = job.data;
      const session = await sessionStore.get(userId);
      if (!session) return;

      if (session.expiresAt > Date.now() && session.expiresAt !== expiresAt) {
        logger.info('Skipped stale AFK queue job', { userId, jobId: job.id, jobName: job.name });
        return;
      }

      if (job.name === REMINDER_JOB) {
        await sendDm(slackClient, userId, messages.reminder());
        logger.info('AFK reminder sent', { userId });
        return;
      }

      if (job.name !== AUTO_RETURN_JOB) return;

      await sessionStore.delete(userId);
      await statusManager.clearAfk(userId);
      await sendDm(slackClient, userId, messages.expired());
      logger.info('AFK session expired automatically', { userId });
    },
    { connection: connection.duplicate(), concurrency: 5 }
  );

  worker.on('failed', (job, error) => {
    logger.error('Auto-return job failed', { jobId: job && job.id, error });
  });
  worker.on('error', (error) => logger.error('AFK worker error', { error }));
  queueEvents.on('error', (error) => logger.error('AFK queue events error', { error }));

  async function scheduleAutoReturn(userId, expiresAt) {
    await removeAutoReturn(userId);

    await queue.add(
      REMINDER_JOB,
      { userId, expiresAt },
      {
        jobId: `${userId}:reminder`,
        delay: Math.max(0, expiresAt - Date.now() - REMINDER_BEFORE_MS),
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
        removeOnFail: 1000
      }
    );

    await queue.add(
      AUTO_RETURN_JOB,
      { userId, expiresAt },
      {
        jobId: `${userId}:auto-return`,
        delay: Math.max(0, expiresAt - Date.now()),
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
        removeOnFail: 1000
      }
    );
  }

  async function removeAutoReturn(userId) {
    for (const jobId of [`${userId}:reminder`, `${userId}:auto-return`, userId]) {
      const existing = await queue.getJob(jobId);
      if (existing) {
        try {
          await existing.remove();
        } catch (error) {
          logger.warn('Could not remove AFK queue job; worker will re-check session state', { userId, jobId, error });
        }
      }
    }
  }

  async function queueDepth() {
    const counts = await queue.getJobCounts('active', 'delayed', 'waiting', 'paused');
    return Object.values(counts).reduce((sum, count) => sum + count, 0);
  }

  return { queue, queueEvents, worker, scheduleAutoReturn, removeAutoReturn, queueDepth };
}

module.exports = { AUTO_RETURN_JOB, REMINDER_BEFORE_MS, REMINDER_JOB, createAfkQueue, sendDm };
