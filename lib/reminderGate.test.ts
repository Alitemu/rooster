import { describe, it, expect } from 'vitest';
import { checkRemindersAllowed } from './reminderGate';

/**
 * The rule: a reminder names the deadline, so none goes out once that
 * deadline has passed, or with the text of a deadline that has since been
 * moved. Only an open period gets reminders at all.
 */

const now = new Date('2027-01-10T12:00:00');

describe('checkRemindersAllowed', () => {
  it('allows reminders for an open period before its deadline', () => {
    expect(checkRemindersAllowed({ status: 'OPEN', deadline: '2027-01-10T12:01' }, {}, now)).toEqual({ allowed: true });
  });

  it('refuses once the deadline has passed, to the minute', () => {
    const result = checkRemindersAllowed({ status: 'OPEN', deadline: '2027-01-10T11:59' }, {}, now);
    expect(result).toMatchObject({ allowed: false, code: 'DEADLINE_PASSED' });
  });

  it('refuses a text written for a deadline that has since been moved', () => {
    const result = checkRemindersAllowed(
      { status: 'OPEN', deadline: '2027-01-20T17:00' },
      { generatedFor: '2027-01-15T17:00' },
      now
    );
    expect(result).toMatchObject({ allowed: false, code: 'DEADLINE_CHANGED' });
  });

  it('refuses for a period that is not open', () => {
    for (const status of ['CONCEPT', 'GESLOTEN', 'GEGENEREERD', 'GEPUBLICEERD']) {
      const result = checkRemindersAllowed({ status, deadline: '2099-01-01T00:00' }, {}, now);
      expect(result).toMatchObject({ allowed: false, code: 'PERIOD_NOT_OPEN' });
    }
  });
});
