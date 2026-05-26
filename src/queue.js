'use strict';

const { Queue, Worker, QueueEvents } = require('bullmq');

const AUTO_RETURN_JOB = 'auto-return';

function createAfkQueue({ queueName, connection, sessionStore, slackClient, statusManager, channelId, logger }) {
  const queue = new Queue(queueName, { connection });
  const queueEvents = new QueueEvents(queueName, { connection: connection.duplicate() });

  const worker = new Worker(
    queueName,
    async (job) => {
      if (job.name !== AUTO_RETURN_JOB) return;

      const { userId, expiresAt } = job.data;
      const session = await sessionStore.get(userId);
      if (!session) return;

      if (session.expiresAt > Date.now() && session.expiresAt !== expiresAt) {
        logger.info('Skipped stale auto-return job', { userId, jobId: job.id });
        return;
      }

      await sessionStore.delete(userId);
      await statusManager.clearAfk(userId);
      await slackClient.chat.postMessage({
        channel: channelId,
        text: `<@${userId}> is back automatically.`
      });
      logger.info('AFK session auto-returned', { userId });
    },
    { connection: connection.duplicate(), concurrency: 5 }
  );

  worker.on('failed', (job, error) => {
    logger.error('Auto-return job failed', { jobId: job && job.id, error });
  });
  worker.on('error', (error) => logger.error('AFK worker error', { error }));
  queueEvents.on('error', (error) => logger.error('AFK queue events error', { error }));

  async function scheduleAutoReturn(userId, expiresAt) {
    const existing = await queue.getJob(userId);
    if (existing) {
      await existing.remove();
    }

    await queue.add(
      AUTO_RETURN_JOB,
      { userId, expiresAt },
      {
        jobId: userId,
        delay: Math.max(0, expiresAt - Date.now()),
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
        removeOnFail: 1000
      }
    );
  }

  async function removeAutoReturn(userId) {
    const existing = await queue.getJob(userId);
    if (existing) {
      await existing.remove();
    }
  }

  async function queueDepth() {
    const counts = await queue.getJobCounts('active', 'delayed', 'waiting', 'paused');
    return Object.values(counts).reduce((sum, count) => sum + count, 0);
  }

  return { queue, queueEvents, worker, scheduleAutoReturn, removeAutoReturn, queueDepth };
}

module.exports = { AUTO_RETURN_JOB, createAfkQueue };
