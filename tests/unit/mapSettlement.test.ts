import '@subql/types-core/dist/global';
import '@subql/types/dist/global';
import {
  handleInstructionMediators,
  handleMediatorAffirmationReceived,
  handleMediatorAffirmationWithdrawn,
  handleReceiptClaimed,
} from '../../src/mappings/entities/settlements/mapSettlement';
import { AffirmStatusEnum, InstructionEventEnum } from '../../src/types';
import { codec, MockDb, mockStore, tupleEvent } from './helpers';

describe('instruction creation routing', () => {
  it('routes both forms of the created event to handleInstructionCreated', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const project = require('../../project').default;
    const routed = (project.dataSources as Array<{ mapping: { handlers: any[] } }>)
      .flatMap(source => source.mapping.handlers)
      .filter(({ handler }) => handler === 'handleInstructionCreated')
      .map(({ filter }) => `${filter.module}.${filter.method}`);

    expect(routed).toEqual(
      expect.arrayContaining(['settlement.InstructionCreated', 'settlement.InstructionV2Created'])
    );
  });
});

const MEDIATOR = '0x0200000000000000000000000000000000000000000000000000000000000000';
const CALLER = '0x0300000000000000000000000000000000000000000000000000000000000000';
const SIGNER = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const INSTRUCTION = '0000000042';

/**
 * v8 declares both events with positional fields, so the shape table names them; a mediator's
 * withdrawal is `(mediatorDid, instructionId)` and a receipt claim is `(callerDid, instructionId,
 * legId, receiptUid, signer, metadata)`.
 */
describe('mediator withdrawals and off-chain receipts', () => {
  let db: MockDb;

  beforeEach(() => {
    db = mockStore();
  });

  const mediatorRow = (did: string) => `${INSTRUCTION}/mediator/${did}`;
  const received = (did: string, idx = 1, expiry: unknown = null) =>
    handleMediatorAffirmationReceived(
      tupleEvent({
        section: 'settlement',
        method: 'MediatorAffirmationReceived',
        data: [codec(did), codec(42), codec(expiry)],
        idx,
        extrinsic: { idx: 1, extrinsic: { signer: { toString: () => SIGNER } } },
      })
    );
  const withdrawn = (did: string, idx = 2) =>
    handleMediatorAffirmationWithdrawn(
      tupleEvent({
        section: 'settlement',
        method: 'MediatorAffirmationWithdrawn',
        data: [codec(did), codec(42)],
        idx,
      })
    );
  const announced = (dids: string[], idx = 0) =>
    handleInstructionMediators(
      tupleEvent({
        section: 'settlement',
        method: 'InstructionMediators',
        data: [codec(42), codec(dids)],
        idx,
        extrinsic: { idx: 1, extrinsic: { signer: { toString: () => SIGNER } } },
      })
    );
  const other = '0x0400000000000000000000000000000000000000000000000000000000000000';

  it('mediators start pending', async () => {
    db.Instruction = { [INSTRUCTION]: { id: INSTRUCTION, mediators: [] } };

    await announced([MEDIATOR, other]);

    for (const did of [MEDIATOR, other]) {
      expect(db.InstructionAffirmation[mediatorRow(did)]).toMatchObject({
        instructionId: INSTRUCTION,
        identityId: did,
        isMediator: true,
        status: 'Pending',
        partyId: `${INSTRUCTION}/${did}/true`,
      });
      expect(db.InstructionAffirmation[mediatorRow(did)].affirmedById).toBeUndefined();
    }
    expect(db.InstructionEvent['0000001000/0000000000/0']).toMatchObject({
      event: InstructionEventEnum.InstructionMediators,
      identityId: MEDIATOR,
      signerId: SIGNER,
    });
  });

  it('mediator affirms and withdraws', async () => {
    db.Instruction = { [INSTRUCTION]: { id: INSTRUCTION, mediators: [] } };
    await announced([MEDIATOR]);

    await received(MEDIATOR, 1, '1767225600000');
    expect(db.InstructionAffirmation[mediatorRow(MEDIATOR)]).toMatchObject({
      status: 'Affirmed',
      expiry: new Date(1767225600000),
      affirmedById: MEDIATOR,
      signerId: SIGNER,
    });
    expect(db.InstructionEvent['0000001000/0000000001']).toMatchObject({
      event: InstructionEventEnum.MediatorAffirmationReceived,
      identityId: MEDIATOR,
      signerId: SIGNER,
    });

    await withdrawn(MEDIATOR);
    const row = db.InstructionAffirmation[mediatorRow(MEDIATOR)];
    expect(row).toMatchObject({ status: 'Pending', affirmedById: MEDIATOR });
    expect(row.expiry).toBeUndefined();
    expect(db.InstructionEvent['0000001000/0000000002']).toMatchObject({
      event: InstructionEventEnum.MediatorAffirmationWithdrawn,
      identityId: MEDIATOR,
    });
  });

  it('mediator affirms before the mediators are announced', async () => {
    db.Instruction = { [INSTRUCTION]: { id: INSTRUCTION, mediators: [] } };

    await received(MEDIATOR, 1);
    expect(db.InstructionAffirmation[mediatorRow(MEDIATOR)].status).toBe('Affirmed');
    expect(db.InstructionParty[`${INSTRUCTION}/${MEDIATOR}/true`]).toMatchObject({
      isMediator: true,
      identityId: MEDIATOR,
    });

    await announced([MEDIATOR], 2);
    expect(db.InstructionAffirmation[mediatorRow(MEDIATOR)].status).toBe('Affirmed');
  });

  it('a mediator withdrawal leaves another mediator and a holder alone', async () => {
    db.InstructionAffirmation = {
      [mediatorRow(MEDIATOR)]: { id: mediatorRow(MEDIATOR), status: 'Affirmed' },
      [mediatorRow(other)]: { id: mediatorRow(other), status: 'Affirmed' },
      [`${INSTRUCTION}/${MEDIATOR}/0`]: { id: `${INSTRUCTION}/${MEDIATOR}/0`, status: 'Affirmed' },
    };

    await withdrawn(MEDIATOR);

    expect(db.InstructionAffirmation[mediatorRow(MEDIATOR)].status).toBe('Pending');
    expect(db.InstructionAffirmation[mediatorRow(other)]).toEqual({
      id: mediatorRow(other),
      status: 'Affirmed',
    });
    expect(db.InstructionAffirmation[`${INSTRUCTION}/${MEDIATOR}/0`]).toEqual({
      id: `${INSTRUCTION}/${MEDIATOR}/0`,
      status: 'Affirmed',
    });
  });

  it('ReceiptClaimed records the receipt, the affirmation it makes, and the event', async () => {
    await handleReceiptClaimed(
      tupleEvent({
        section: 'settlement',
        method: 'ReceiptClaimed',
        data: [codec(CALLER), codec(42), codec(3), codec(7), codec(SIGNER), codec('0xabcd')],
        idx: 5,
      })
    );

    const blockEventId = '0000001000/0000000005';
    expect(db.OffChainReceipt[`${SIGNER}/7`]).toMatchObject({
      uid: 7,
      signerId: SIGNER,
      legId: `${INSTRUCTION}/3`,
      metadata: '0xabcd',
      createdEventId: blockEventId,
    });
    expect(db.InstructionAffirmation[`${INSTRUCTION}/${CALLER}/false/${SIGNER}/7`]).toMatchObject({
      instructionId: INSTRUCTION,
      identityId: CALLER,
      partyId: `${INSTRUCTION}/${CALLER}/false`,
      status: AffirmStatusEnum.Affirmed,
      isMediator: false,
      isAutomaticallyAffirmed: false,
      offChainReceiptId: `${SIGNER}/7`,
    });
    expect(db.InstructionEvent[`${blockEventId}/receipt/3`]).toMatchObject({
      instructionId: INSTRUCTION,
      event: InstructionEventEnum.ReceiptClaimed,
      identityId: CALLER,
      offChainReceiptId: `${SIGNER}/7`,
    });
    expect(db.InstructionParty[`${INSTRUCTION}/${CALLER}/false`]).toMatchObject({
      instructionId: INSTRUCTION,
      identityId: CALLER,
      isMediator: false,
    });
  });

  it('ReceiptClaimed keeps the party the instruction already has', async () => {
    const partyId = `${INSTRUCTION}/${CALLER}/false`;
    db.InstructionParty = { [partyId]: { id: partyId, createdEventId: 'earlier' } };

    await handleReceiptClaimed(
      tupleEvent({
        section: 'settlement',
        method: 'ReceiptClaimed',
        data: [codec(CALLER), codec(42), codec(0), codec(1), codec(SIGNER), codec(null)],
      })
    );

    expect(db.InstructionParty[partyId]).toEqual({ id: partyId, createdEventId: 'earlier' });
    expect(db.OffChainReceipt[`${SIGNER}/1`]).toBeDefined();
  });

  it('ReceiptClaimed for two legs of one instruction records a receipt and an event for each', async () => {
    for (const [leg, uid] of [
      [0, 10],
      [1, 11],
    ]) {
      await handleReceiptClaimed(
        tupleEvent({
          section: 'settlement',
          method: 'ReceiptClaimed',
          data: [codec(CALLER), codec(42), codec(leg), codec(uid), codec(SIGNER), codec(null)],
          idx: 3,
        })
      );
    }

    expect(Object.keys(db.OffChainReceipt).sort()).toEqual([`${SIGNER}/10`, `${SIGNER}/11`]);
    expect(Object.keys(db.InstructionEvent).sort()).toEqual([
      '0000001000/0000000003/receipt/0',
      '0000001000/0000000003/receipt/1',
    ]);
  });
});
