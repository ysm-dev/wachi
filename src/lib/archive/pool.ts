export const ARCHIVE_POOL_MAX_CONCURRENT = 4;
export const ARCHIVE_POOL_FLUSH_TIMEOUT_MS = 15_000;

const pendingTasks: Array<() => Promise<void>> = [];
const inflightTasks = new Set<Promise<void>>();

let activeCount = 0;

const startNextTasks = (): void => {
  while (activeCount < ARCHIVE_POOL_MAX_CONCURRENT && pendingTasks.length > 0) {
    const task = pendingTasks.shift();
    if (!task) {
      return;
    }

    activeCount += 1;

    let inflightTask!: Promise<void>;
    inflightTask = task()
      .catch(() => {
        return;
      })
      .finally(() => {
        activeCount -= 1;
        inflightTasks.delete(inflightTask);
        startNextTasks();
      });

    inflightTasks.add(inflightTask);
  }
};

export const trackArchive = (task: () => Promise<void>): void => {
  pendingTasks.push(task);
  startNextTasks();
};

export const flushArchivePool = async (
  timeoutMs = ARCHIVE_POOL_FLUSH_TIMEOUT_MS,
): Promise<void> => {
  if (pendingTasks.length === 0 && inflightTasks.size === 0) {
    return;
  }

  const deadline = Date.now() + timeoutMs;
  while (pendingTasks.length > 0 || inflightTasks.size > 0) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return;
    }

    if (inflightTasks.size === 0) {
      return;
    }

    await Promise.race([
      Promise.race(inflightTasks),
      new Promise<void>((resolve) => setTimeout(resolve, remainingMs)),
    ]);
  }
};

export const resetArchivePoolForTest = (): void => {
  activeCount = 0;
  pendingTasks.length = 0;
  inflightTasks.clear();
};
