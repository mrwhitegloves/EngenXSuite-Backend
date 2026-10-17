import { describe, expect, it, vi } from 'vitest';

// Gmail is replaced: the raw message that would be sent is caught here.
const sent = [];
vi.stubGlobal('fetch', async (url, options) => {
  sent.push(JSON.parse(options.body));
  return new Response(JSON.stringify({ id: 'm1', threadId: 't1' }), { status: 200 });
});

const { cleanMailHtml } = await import('../lib/mailHtml.js');
const { sendMessage } = await import('../integrations/google/gmail.js');

const decode = (raw) => Buffer.from(raw, 'base64url').toString('utf8');
const partBodies = (whole) =>
  [
    ...whole.matchAll(
      /Content-Type: (text\/(?:plain|html)); charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/g,
    ),
  ].map(([, type, body]) => ({
    type,
    content: Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'),
  }));

describe('the laid-out form of a mail', () => {
  it('keeps the layout and takes out what could run or load something', () => {
    const html = [
      '<h3>Key areas discussed</h3>',
      '<p onclick="alert(1)">Dear <b>Arvind</b>,</p>',
      '<ul><li><strong>Condition Monitoring</strong></li></ul>',
      '<script>alert(1)</script><style>p{}</style>',
      '<a href="javascript:alert(1)">bad</a> <a href="https://engenx.in">good</a>',
      '<img src="data:image/png;base64,AAAA"><iframe src="https://x.example"></iframe>',
    ].join('');
    const clean = cleanMailHtml(html);
    expect(clean).toContain('<h3>Key areas discussed</h3>');
    expect(clean).toContain('<b>Arvind</b>');
    expect(clean).toContain('<ul><li><strong>Condition Monitoring</strong></li></ul>');
    expect(clean).toContain('<a href="https://engenx.in">good</a>');
    for (const bad of [
      '<script',
      'alert(1)</script',
      '<style',
      'onclick',
      'javascript:',
      'data:',
      '<iframe',
    ]) {
      expect(clean).not.toContain(bad);
    }
    expect(cleanMailHtml('<p>&nbsp;</p><br>')).toBeUndefined();
    expect(cleanMailHtml(undefined)).toBeUndefined();
  });

  it('goes out as plain text and HTML together, also with a file', async () => {
    sent.length = 0;
    const mail = {
      from: 'kunal@engenx.in',
      to: ['arvind@client.example'],
      subject: 'Meeting summary',
      text: 'Dear Arvind,\n\nKey areas discussed',
      html: '<p>Dear Arvind,</p><h3>Key areas discussed</h3>',
    };
    await sendMessage('token', mail);
    const plain = decode(sent[0].raw);
    expect(plain).toContain('Content-Type: multipart/alternative;');
    expect(partBodies(plain)).toEqual([
      { type: 'text/plain', content: mail.text },
      { type: 'text/html', content: mail.html },
    ]);

    await sendMessage('token', {
      ...mail,
      attachments: [
        { filename: 'offer.pdf', mimeType: 'application/pdf', content: Buffer.from('%PDF') },
      ],
    });
    const withFile = decode(sent[1].raw);
    expect(withFile).toContain('Content-Type: multipart/mixed;');
    expect(withFile).toContain('Content-Type: multipart/alternative;');
    expect(withFile).toContain('filename="offer.pdf"');
    expect(partBodies(withFile).map((part) => part.type)).toEqual(['text/plain', 'text/html']);

    // Without a layout: plain text only, as before.
    await sendMessage('token', { ...mail, html: undefined });
    const only = decode(sent[2].raw);
    expect(only).not.toContain('multipart');
    expect(partBodies(only)).toEqual([{ type: 'text/plain', content: mail.text }]);
  });
});
