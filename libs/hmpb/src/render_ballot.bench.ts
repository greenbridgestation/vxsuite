import { HmpbBallotPaperSize } from '@votingworks/types';
import { afterAll, beforeAll, test } from 'vitest';
import { vxGeneralElectionFixtures } from './ballot_fixtures';
import { createPlaywrightRendererPool } from './playwright_renderer';
import { RendererPool } from './renderer';

let rendererPool: RendererPool;
beforeAll(async () => {
  rendererPool = await createPlaywrightRendererPool();
});

afterAll(async () => {
  await rendererPool.close();
});

const RUN_OPTIONS = { iterations: 3, warmupIterations: 1, time: 0 };

// Results vary widely between machines, so each environment gets its own
// baseline: `pnpm benchmark` records one, `pnpm benchmark:compare` measures the
// current code against it.
const baselinePath = `bench-results/${
  process.env['BENCH_ENV'] || 'default'
}.json`;

test('ballot PDF generation', { timeout: 10 * 60 * 1000 }, async ({ bench }) => {
  const specs = vxGeneralElectionFixtures.fixtureSpecs.filter(
    (spec) => spec.paperSize === HmpbBallotPaperSize.Letter
  );

  // Must be `async`: tinybench probes a non-async function once without
  // awaiting it, which would overlap two renderer runs.
  async function generateLetterBallots() {
    await vxGeneralElectionFixtures.generate(rendererPool, specs);
  }

  if (process.env['BENCH_RECORD']) {
    await bench(
      'generate VX general election letter ballots',
      { writeResult: baselinePath },
      generateLetterBallots
    ).run(RUN_OPTIONS);
  } else {
    await bench.compare(
      bench.from('baseline', baselinePath),
      bench('current', generateLetterBallots),
      RUN_OPTIONS
    );
  }
});
