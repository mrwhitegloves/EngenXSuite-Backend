import { describe, expect, it } from 'vitest';
import { canonicalFieldName, normalizeInboundFields } from '../lib/fieldNames.js';

describe('one database name for email and phone, whatever the source calls them', () => {
  it('recognises every usual name of an email field', () => {
    for (const name of [
      'email',
      'Email',
      'E-mail',
      'e mail',
      'mail',
      'work_email',
      'workEmail',
      'email_id',
      'Email ID',
      'email_address',
      'Email Address*',
      'official e-mail id',
      'Mail ID',
      'EMAIL',
    ]) {
      expect(canonicalFieldName(name), name).toBe('email');
    }
  });

  it('recognises every usual name of a phone field', () => {
    for (const name of [
      'phone',
      'Phone',
      'mobile',
      'Mobile No.',
      'mobile_number',
      'telephone',
      'tel',
      'Tel.',
      'whatsapp',
      'WhatsApp Number',
      'phone_number',
      'phoneNumber',
      'Contact No',
      'contact_number',
      'Cell',
      'Mob',
      'PHONE NO',
    ]) {
      expect(canonicalFieldName(name), name).toBe('phone_number');
    }
  });

  it('leaves other fields alone, also those that only look similar', () => {
    for (const name of [
      'full_name',
      'city',
      'company_name',
      'hotel',
      'Model',
      'mailing_address',
      'mobility partner',
      'telecom vendor',
      'GST number',
      'number of plants',
      'contact person',
      '',
    ]) {
      expect(canonicalFieldName(name), name).toBeNull();
    }
  });

  it('turns a Meta lead form answer list into database names and forms', () => {
    const { fields, renamed } = normalizeInboundFields([
      { name: 'full_name', values: ['Asha Verma'] },
      { name: 'work_email', values: [' Asha.Verma@Example.COM '] },
      { name: 'Mobile No.', values: ['98765 43210'] },
      { name: 'company_name', values: ['Bharat Forge'] },
      { name: 'which_solution_are_you_interested_in?', values: ['Digital Twin'] },
    ]);
    expect(fields).toEqual({
      full_name: 'Asha Verma',
      email: 'asha.verma@example.com',
      phone_number: '+919876543210',
      company_name: 'Bharat Forge',
      'which_solution_are_you_interested_in?': 'Digital Twin',
    });
    expect(renamed).toEqual([
      { from: 'work_email', to: 'email' },
      { from: 'Mobile No.', to: 'phone_number' },
    ]);
  });

  it('turns a spreadsheet row into the same names', () => {
    const { fields } = normalizeInboundFields({
      Name: 'Omar',
      'E-mail': 'OMAR@example.com',
      Tel: '020 2612 3456',
      City: 'Pune',
    });
    expect(fields).toEqual({
      Name: 'Omar',
      email: 'omar@example.com',
      phone_number: '+912026123456',
      City: 'Pune',
    });
  });

  it('keeps a second, different number or address instead of losing or overwriting it', () => {
    const { fields } = normalizeInboundFields({
      phone: '9876543210',
      'WhatsApp Number': '9123456780',
      email: 'a@example.com',
      'Alternate Email': 'b@example.com',
    });
    expect(fields).toEqual({
      phone_number: '+919876543210',
      whatsapp_number: '+919123456780',
      email: 'a@example.com',
      alternate_email: 'b@example.com',
    });
  });

  it('the same value under two names is stored once', () => {
    const { fields } = normalizeInboundFields({
      mobile: '98765-43210',
      whatsapp: '+91 9876543210',
      email: 'a@example.com',
      mail: 'A@example.com',
    });
    expect(fields).toEqual({ phone_number: '+919876543210', email: 'a@example.com' });
  });

  it('an empty column never erases a value, and a filled one fills an empty first one', () => {
    expect(normalizeInboundFields({ phone: '', mobile: '9876543210' }).fields).toEqual({
      phone_number: '+919876543210',
    });
    expect(normalizeInboundFields({ mobile: '9876543210', phone: '  ' }).fields).toEqual({
      phone_number: '+919876543210',
    });
    expect(normalizeInboundFields({ email: null }).fields).toEqual({ email: null });
  });

  it('a number that cannot be understood is kept as typed, not dropped', () => {
    expect(normalizeInboundFields({ phone: 'ext 204' }).fields).toEqual({
      phone_number: 'ext 204',
    });
  });

  it('copes with missing or odd input', () => {
    expect(normalizeInboundFields(null).fields).toEqual({});
    expect(normalizeInboundFields([]).fields).toEqual({});
    expect(normalizeInboundFields([{ name: '', values: ['x'] }, null]).fields).toEqual({});
    expect(normalizeInboundFields([{ name: 'phone', value: '9876543210' }]).fields).toEqual({
      phone_number: '+919876543210',
    });
  });
});
