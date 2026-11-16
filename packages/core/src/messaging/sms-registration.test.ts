import { describe, expect, it } from 'vitest';
import { complianceTextProblem, defaultComplianceTexts } from './sms-registration';

describe('defaultComplianceTexts', () => {
  it('writes CTIA-compliant texts that pass their own checks', () => {
    const texts = defaultComplianceTexts({ brandName: 'Pat Plumbing', email: 'pat@example.test' });
    for (const [field, value] of Object.entries(texts)) {
      expect(
        complianceTextProblem(field as keyof typeof texts, value, 'Pat Plumbing'),
        field,
      ).toBeNull();
    }
    expect(texts.optinMessage).toMatch(
      /Msg frequency varies\. Msg & data rates may apply\. Reply HELP for help, STOP to opt out\./,
    );
    expect(texts.optoutMessage).toMatch(/no further messages/);
    expect(texts.helpMessage).toContain('pat@example.test');
  });

  it('flags texts carriers would refuse', () => {
    expect(complianceTextProblem('helpMessage', 'Short', 'Pat')).toMatch(/20 to 320/);
    expect(
      complianceTextProblem(
        'helpMessage',
        'Email help@example.test for help with texts.',
        'Pat Plumbing',
      ),
    ).toBe('Name your business.');
    expect(
      complianceTextProblem(
        'optinMessage',
        'Pat Plumbing: you are subscribed to our texts here.',
        'Pat Plumbing',
      ),
    ).toMatch(/STOP/);
    expect(complianceTextProblem('messageFlow', 'Too short', 'Pat')).toMatch(/at least 40/);
  });
});
