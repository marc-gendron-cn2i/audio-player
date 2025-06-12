// index.js
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  PollyClient,
  SynthesizeSpeechCommand
} from "@aws-sdk/client-polly";

const {
  ARC_API_BASE_URL,
  ARC_API_TOKEN,
  AUDIO_BUCKET,
  S3_BUCKET_REGION,
  POLLY_VOICE_ID,
  AWS_REGION
} = process.env;

const s3 = new S3Client({ region: S3_BUCKET_REGION });
const polly = new PollyClient({ region: AWS_REGION });

// Découpe en segments ≤ maxLength (3000)
function chunkText(text, maxLength = 3000) {
  const paras = text.split("\n\n");
  const chunks = [];
  let curr = "";
  for (const p of paras) {
    if (p.length > maxLength) {
      if (curr) { chunks.push(curr.trim()); curr = ""; }
      for (let i = 0; i < p.length; i += maxLength) {
        chunks.push(p.slice(i, i + maxLength));
      }
    } else if ((curr + "\n\n" + p).length <= maxLength) {
      curr = curr ? curr + "\n\n" + p : p;
    } else {
      chunks.push(curr.trim());
      curr = p;
    }
  }
  if (curr) chunks.push(curr.trim());
  return chunks;
}

// ReadableStream → Buffer
async function streamToBuffer(stream) {
  const bufs = [];
  for await (const c of stream) {
    bufs.push(typeof c === "string" ? Buffer.from(c) : c);
  }
  return Buffer.concat(bufs);
}

export const handler = async (event) => {
  try {
    // 1. Fetch draft
    const storyId = event.pathParameters.id;
    const res = await fetch(
      `${ARC_API_BASE_URL}/draft/v1/story/${storyId}/revision/draft`,
      { headers: { Authorization: `Bearer ${ARC_API_TOKEN}` } }
    );
    if (!res.ok) throw new Error(`Arc XP fetch failed: ${res.status}`);
    const draft = await res.json();

    // 2. Extract ans + metadata
    const ans = draft.ans;
    const title       = ans.headlines?.basic?.trim() || "";
    const author      = ans.credits?.by
                         ?.map(b => b.referent?.id || b.referent?.text)
                         .filter(Boolean)[0] || "";
    const subheadline = ans.subheadlines?.basic?.trim() || "";

    // 3. Build body blocks
    const bodyBlocks = ans.content_elements
      .filter(el => el.type === "text" && typeof el.content === "string")
      .map(el => el.content.trim());

    // 4. Assemble full text in desired order
    const parts = [];
    if (title)       parts.push(title);
    if (author)      parts.push(`par ${author}`);
    if (subheadline) parts.push(subheadline);
    parts.push(...bodyBlocks);
    const fullText = parts.join("\n\n");

    // 5. Split into Polly-friendly chunks
    const segments = chunkText(fullText, 3000);

    // 6. Generate audio for each chunk
    const buffers = [];
    for (const seg of segments) {
      const { AudioStream } = await polly.send(
        new SynthesizeSpeechCommand({
          Text: seg,
          VoiceId: POLLY_VOICE_ID,
          OutputFormat: "mp3",
          Engine: "neural",
          TextType: "text",
          LexiconNames: ["LexiqueCN2i"]
        })
      );
      if (!AudioStream) throw new Error("Empty AudioStream");
      buffers.push(await streamToBuffer(AudioStream));
    }

    // 7. Concat buffers & upload
    const finalBuf = Buffer.concat(buffers);
    const key = `audio/${storyId}.mp3`;
    await s3.send(new PutObjectCommand({
      Bucket: AUDIO_BUCKET,
      Key: key,
      Body: finalBuf,
      ContentType: "audio/mpeg"
    }));
    const audioUrl = `https://${AUDIO_BUCKET}.s3.${S3_BUCKET_REGION}.amazonaws.com/${key}`;

    // 8. Return URL
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, audioUrl })
    };

  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
