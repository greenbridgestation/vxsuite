import { afterAll, beforeAll, beforeEach, expect } from 'vitest';
import matchers from '@testing-library/jest-dom/matchers';
import { cleanup, configure } from '@testing-library/react';
import {
  clearTemporaryRootDir,
  setupTemporaryRootDir,
} from '@votingworks/fixtures';
import { buildToMatchPdfSnapshot } from '@votingworks/image-utils';
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';
import { toMatchImageSnapshot } from 'jest-image-snapshot';
import {
  buildToHaveStyleRule,
  ToHaveStyleRuleMatchers,
} from 'vitest-styled-components';

declare module 'vitest' {
  /* eslint-disable-next-line @typescript-eslint/no-unused-vars,
     @typescript-eslint/no-explicit-any */
  interface Matchers<R, T> extends TestingLibraryMatchers<any, R> {
    toHaveStyleRule: ToHaveStyleRuleMatchers['toHaveStyleRule'];
  }
}

// Vitest 5's `MatchersObject` index signature only accepts matchers whose
// arguments are typed `unknown[]`, so implementations registered as properties
// need a cast. The assertion-side types declared above stay precise.
type MatcherImplementations = Parameters<typeof expect.extend>[0];

const customMatchers = {
  toHaveStyleRule: buildToHaveStyleRule(expect),
  toMatchImageSnapshot,
  toMatchPdfSnapshot: buildToMatchPdfSnapshot(expect),
} as const;

expect.extend(matchers as unknown as MatcherImplementations);
expect.extend(customMatchers as unknown as MatcherImplementations);

beforeEach(cleanup);

configure({ asyncUtilTimeout: 5_000 });

beforeAll(setupTemporaryRootDir);
afterAll(clearTemporaryRootDir);
