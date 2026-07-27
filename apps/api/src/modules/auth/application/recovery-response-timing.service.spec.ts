import { RecoveryResponseTimingService } from './recovery-response-timing.service.js';

describe('RecoveryResponseTimingService', () => {
  it('waits for the common floor plus cryptographic jitter without busy waiting', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const randomJitter = vi.fn().mockReturnValue(25);
    const now = vi.fn().mockReturnValueOnce(1_000).mockReturnValueOnce(1_125);
    const budget = new RecoveryResponseTimingService().start({ now, randomJitter, sleep });

    await budget.wait();
    await budget.wait();

    expect(randomJitter).toHaveBeenCalledWith(100);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(200);
  });

  it('does not add delay when processing already exceeds the randomized target', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const budget = new RecoveryResponseTimingService().start({
      now: vi.fn().mockReturnValueOnce(1_000).mockReturnValueOnce(1_500),
      randomJitter: vi.fn().mockReturnValue(50),
      sleep,
    });

    await budget.wait();

    expect(sleep).not.toHaveBeenCalled();
  });
});
