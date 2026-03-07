/**
 * Shared utility: race a promise against a timeout.
 * Previously duplicated in index.ts, router.ts, and health.ts.
 */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    });

    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
        }
    }
}
