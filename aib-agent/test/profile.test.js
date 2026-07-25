/**
 * Tests for the export profiler.
 *
 * The profiler has one safety property: nothing it emits should identify a
 * client, a member or a claim. That is a promise made to whoever runs it
 * against a live export, so it is tested rather than assumed — the interesting
 * cases are the ones where a value could slip through as itself.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { fingerprint, profileRows, looksPersonalColumn } from '../scripts/profile-export.js';

describe('fingerprinting', () => {
  test('identifiers keep their structure and lose their content', () => {
    assert.equal(fingerprint('CL-1004'), 'AA-9999');
    assert.equal(fingerprint('POL/2024/00817'), 'AAA/9999/99999');
    assert.notEqual(fingerprint('CL-1004'), 'CL-1004');
  });

  test('contact details are replaced outright, never shaped', () => {
    assert.equal(fingerprint('roshni.persad@example.co.tt'), '<email>');
    assert.equal(fingerprint('+1868-623-0576'), '<phone>');
    assert.equal(fingerprint('(868) 623 0576'), '<phone>');
  });

  test('a large monetary amount is a number, not a phone number', () => {
    // Regression: an eight-digit sum insured was being read as a phone and
    // then flagged as personal data.
    assert.match(fingerprint('24500000'), /^<integer/);
    assert.match(fingerprint('5000000'), /^<integer/);
    assert.match(fingerprint('1,240,000.00'), /^<decimal|^<integer/);
  });

  test('an eight-digit run is only a date when it plausibly is one', () => {
    assert.equal(fingerprint('20260725'), 'YYYYMMDD');
    assert.equal(fingerprint('25072026'), 'DDMMYYYY');
    assert.match(fingerprint('24500000'), /^<integer/, 'not a date — month 00');
  });

  test('date formats are reported, and ambiguity is called ambiguous', () => {
    assert.equal(fingerprint('2026-07-25'), 'YYYY-MM-DD');
    assert.match(fingerprint('01/03/2024'), /ambiguous/);
  });

  test('free text is reduced to a rounded length', () => {
    const note = 'Dental care, treatment or surgery is excluded under the terms of this plan entirely';
    const shape = fingerprint(note);
    assert.match(shape, /^<text len~/);
    assert.ok(!shape.includes('Dental'), 'text content must not survive');
  });

  test('empty values are distinguishable from populated ones', () => {
    for (const empty of ['', null, undefined]) assert.equal(fingerprint(empty), '<empty>');
  });
});

describe('profiling', () => {
  const rows = [
    { CLIENT_REF: 'C-00412', MEMBER_NAME: 'Anand Ramsingh', STATUS: 'ACTIVE', CCY: 'TTD', PREMIUM: '84500' },
    { CLIENT_REF: 'C-00413', MEMBER_NAME: 'Priya Maharaj', STATUS: 'LAPSED', CCY: 'TTD', PREMIUM: '' },
    { CLIENT_REF: 'C-00414', MEMBER_NAME: 'Curtis Alleyne', STATUS: 'ACTIVE', CCY: 'USD', PREMIUM: '12000' },
  ];

  test('fill rate reflects populated values', () => {
    const profile = profileRows(rows, 'policies');
    const premium = profile.columns.find((c) => c.column === 'PREMIUM');
    assert.equal(premium.fillRate, 0.667);
    assert.equal(profile.rows, 3);
  });

  test('columns that look personal are flagged', () => {
    const profile = profileRows(rows, 'policies');
    assert.equal(profile.columns.find((c) => c.column === 'MEMBER_NAME').looksPersonal, true);
    assert.equal(profile.columns.find((c) => c.column === 'CCY').looksPersonal, false);
  });

  test('no column value appears anywhere in the default output', () => {
    const serialised = JSON.stringify(profileRows(rows, 'policies'));
    for (const secret of ['Anand', 'Ramsingh', 'Priya', 'Maharaj', 'Curtis', 'Alleyne', 'C-00412', '84500']) {
      assert.ok(!serialised.includes(secret), `"${secret}" leaked into the profile`);
    }
  });

  test('a column is only personal when the name refers to a person', () => {
    // Found on a real broking export: "Policy Type Name" and "Profit Centre
    // Name" were flagged, which suppressed the taxonomy columns most needed
    // to write a mapping.
    for (const personal of ['Name', 'Member Name', 'Account Name', 'Contact Email', 'DOB', 'Home Address']) {
      assert.equal(looksPersonalColumn(personal), true, `${personal} should be flagged`);
    }
    for (const structural of ['Policy Type Name', 'Department Name', 'Profit Centre Name', 'Branch Name', 'Policy Number']) {
      assert.equal(looksPersonalColumn(structural), false, `${structural} should not be flagged`);
    }
  });

  test('sparse records still contribute their columns', () => {
    const profile = profileRows([{ a: 1 }, { b: 2 }], 'mixed');
    assert.deepEqual(profile.columns.map((c) => c.column).sort(), ['a', 'b']);
  });

  test('an empty table profiles without throwing', () => {
    assert.deepEqual(profileRows([], 'empty'), { name: 'empty', rows: 0, columns: [] });
  });
});
