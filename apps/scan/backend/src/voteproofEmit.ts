import { closeSync, constants, openSync, writeSync } from 'node:fs';
import {
  AcceptedSheet,
  buildCastVoteRecord,
  getMachineId,
} from '@votingworks/backend';
import { extractErrorMessage } from '@votingworks/basics';
import { LogEventId, Logger } from '@votingworks/logging';
import {
  BallotIdSchema,
  CVR,
  Contest,
  Election,
  InterpretedBmdPage,
  InterpretedHmpbPage,
  PageInterpretation,
  SheetOf,
  unsafeParse,
} from '@votingworks/types';
import { encryptBallotAuditId } from './export.js';
import { Store } from './store.js';

const DEFAULT_PIPE_PATH = '/tmp/voteproof-cvr';

export function getVoteProofPipePath(): string {
  return process.env.VOTEPROOF_PIPE ?? DEFAULT_PIPE_PATH;
}

function isEmptyPage(page: PageInterpretation): boolean {
  return page.type === 'BlankPage' || page.type === 'UnreadablePage';
}

/**
 * Mirrors libs/backend canonicalizeSheet enough to call the same NIST CVR builder.
 */
function canonicalizeForCvr(sheet: AcceptedSheet):
  | { type: 'bmd'; interpretation: InterpretedBmdPage }
  | { type: 'hmpb'; interpretations: SheetOf<InterpretedHmpbPage> }
  | undefined {
  const [front, back] = sheet.interpretation;
  if (front.type === 'InterpretedBmdPage' && isEmptyPage(back)) {
    return { type: 'bmd', interpretation: front };
  }
  if (isEmptyPage(front) && back.type === 'InterpretedBmdPage') {
    return { type: 'bmd', interpretation: back };
  }
  if (
    front.type !== 'InterpretedHmpbPage' ||
    back.type !== 'InterpretedHmpbPage'
  ) {
    return undefined;
  }
  if (front.metadata.pageNumber + 1 === back.metadata.pageNumber) {
    return { type: 'hmpb', interpretations: [front, back] };
  }
  if (back.metadata.pageNumber + 1 === front.metadata.pageNumber) {
    return { type: 'hmpb', interpretations: [back, front] };
  }
  return undefined;
}

function buildNistCvr(store: Store, sheet: AcceptedSheet): CVR.CVR | undefined {
  const electionRecord = store.getElectionRecord();
  const systemSettings = store.getSystemSettings();
  if (!electionRecord || !systemSettings) {
    return undefined;
  }

  const canonical = canonicalizeForCvr(sheet);
  if (!canonical) {
    return undefined;
  }

  const { electionDefinition } = electionRecord;
  const electionId = electionDefinition.ballotHash;
  const scannerId = getMachineId();
  const castVoteRecordId = unsafeParse(BallotIdSchema, sheet.id);

  if (canonical.type === 'bmd') {
    return buildCastVoteRecord({
      ballotMarkingMode: 'machine',
      batchId: sheet.batchId,
      ballotAuditId: sheet.ballotAuditId,
      castVoteRecordId,
      electionDefinition,
      electionId,
      interpretation: canonical.interpretation,
      scannerId,
    });
  }

  return buildCastVoteRecord({
    ballotMarkingMode: 'hand',
    batchId: sheet.batchId,
    ballotAuditId: sheet.ballotAuditId,
    castVoteRecordId,
    markThresholds: systemSettings.markThresholds,
    electionDefinition,
    electionId,
    interpretations: canonical.interpretations,
    scannerId,
  });
}

function pickSnapshot(cvr: CVR.CVR): CVR.CVRSnapshot | undefined {
  const snapshots = cvr.CVRSnapshot ?? [];
  return (
    snapshots.find((snapshot) => snapshot.Type === CVR.CVRType.Interpreted) ??
    snapshots.find((snapshot) => snapshot.Type === CVR.CVRType.Modified) ??
    snapshots[0]
  );
}

function resolveSelectionLabel(
  election: Election,
  contest: Contest | undefined,
  selection: CVR.CVRContestSelection
): string {
  const id = selection.ContestSelectionId ?? '';
  const writeInText = selection.SelectionPosition?.[0]?.CVRWriteIn?.Text;
  const candidate =
    contest?.type === 'candidate'
      ? contest.candidates.find((c) => c.id === id)
      : undefined;
  if (id.startsWith('write-in-') || Boolean(candidate?.isWriteIn)) {
    return writeInText ? `Write-in: ${writeInText}` : 'Write-in';
  }
  if (contest?.type === 'candidate') {
    return candidate?.name ?? id;
  }
  if (contest?.type === 'yesno') {
    return contest.options.find((option) => option.id === id)?.label ?? id;
  }
  if (contest?.type === 'straight-party') {
    return election.parties.find((party) => party.id === id)?.name ?? id;
  }
  return id;
}

function buildReceipt(
  cvr: CVR.CVR,
  election: Election
): {
  election_title: string;
  contests: Array<{ name: string; selections: string[] }>;
} {
  const snapshot = pickSnapshot(cvr);
  const contests: Array<{ name: string; selections: string[] }> = [];
  for (const cvrContest of snapshot?.CVRContest ?? []) {
    const contest = election.contests.find((c) => c.id === cvrContest.ContestId);
    const name = contest?.title ?? cvrContest.ContestId ?? '';
    if ((cvrContest.Overvotes ?? 0) > 0) {
      contests.push({ name, selections: ['OVERVOTE'] });
      continue;
    }
    const selections: string[] = [];
    for (const selection of cvrContest.CVRContestSelection ?? []) {
      const position = selection.SelectionPosition?.[0];
      if (position?.IsAllocable === CVR.AllocationStatus.Yes) {
        selections.push(resolveSelectionLabel(election, contest, selection));
      }
    }
    contests.push({
      name,
      selections: selections.length > 0 ? selections : ['(no selection)'],
    });
  }
  return { election_title: election.title, contests };
}

function writeNdjsonLineNonBlocking(pipePath: string, line: string): void {
  const fd = openSync(
    pipePath,
    constants.O_WRONLY | constants.O_NONBLOCK | constants.O_APPEND
  );
  try {
    writeSync(fd, line);
  } finally {
    closeSync(fd);
  }
}

/**
 * Lab-only: after an accepted sheet is stored (and USB-exported if enabled),
 * emit one NDJSON line to the VoteProof receipt FIFO. Never throws.
 */
export async function emitVoteProofCvr({
  store,
  sheetId,
  logger,
}: {
  store: Store;
  sheetId: string;
  logger: Logger;
}): Promise<void> {
  try {
    const sheet = store.getSheet(sheetId);
    if (!sheet || sheet.type !== 'accepted') {
      return;
    }

    const systemSettings = store.getSystemSettings();
    const electionRecord = store.getElectionRecord();
    if (!systemSettings || !electionRecord) {
      return;
    }

    const sheetForCvr = await encryptBallotAuditId(
      store,
      systemSettings,
      sheet
    );
    if (sheetForCvr.type !== 'accepted') {
      return;
    }

    const cvr = buildNistCvr(store, sheetForCvr);
    if (!cvr) {
      logger.log(LogEventId.UnknownError, 'system', {
        message: 'VoteProof emit skipped; could not build NIST CVR',
        disposition: 'failure',
      });
      return;
    }

    const message = {
      type: 'cvr' as const,
      scanner_id: cvr.CreatingDeviceId,
      election_id: cvr.ElectionId,
      precinct_id: cvr.BallotStyleUnitId,
      cvr_unique_id: cvr.UniqueId,
      cvr,
      receipt: buildReceipt(cvr, electionRecord.electionDefinition.election),
    };
    writeNdjsonLineNonBlocking(
      getVoteProofPipePath(),
      `${JSON.stringify(message)}\n`
    );
    logger.log(LogEventId.Info, 'system', {
      message: `VoteProof emit success for CVR ${cvr.UniqueId}`,
      disposition: 'success',
    });
  } catch (error) {
    logger.log(LogEventId.UnknownError, 'system', {
      message: `VoteProof pipe write failed; continuing scan: ${extractErrorMessage(error)}`,
      disposition: 'failure',
    });
  }
}
