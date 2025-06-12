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

// Découpe en chunks ≤ maxLength, en coupant sur "\n\n" si possible
function chunkText(text, maxLength = 3000) {
  const paragraphs = text.split("\n\n");
  const chunks = [];
  let current = "";

  for (const para of paragraphs) {
    // si ce paragraphe seul dépasse, on le coupe brut
    if (para.length > maxLength) {
      if (current) {
        chunks.push(current.trim());
        current = "";
      }
      // couper le paragraphe en sous-chaînes de maxLength
      for (let i = 0; i < para.length; i += maxLength) {
        chunks.push(para.slice(i, i + maxLength));
      }
    } else if ((current + "\n\n" + para).length <= maxLength) {
      current = current ? current + "\n\n" + para : para;
    } else {
      chunks.push(current.trim());
      current = para;
    }
  }
  if (current) chunks.push(current.trim());
  return chunks;
}

// Convertit ReadableStream en Buffer
async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export const handler = async (event) => {
  try {
    // 1. Récupérer l’article draft
    const storyId = event.pathParameters.id;
    const draftRes = await fetch(
      `${ARC_API_BASE_URL}/draft/v1/story/${storyId}/revision/draft`,
      { headers: { Authorization: `Bearer ${ARC_API_TOKEN}` } }
    );
    if (!draftRes.ok) throw new Error(`Arc XP fetch failed: ${draftRes.status}`);
    const { ans, subheadlines } = await draftRes.json();

    // 2. Assembler le texte
    const sub = subheadlines?.basic?.trim() || "";
    const blocks = ans.content_elements
      .filter(el => el.type === "text" && typeof el.content === "string")
      .map(el => el.content.trim());
    if (sub) blocks.unshift(sub);
    const fullText = blocks.join("\n\n");

    // 3. Découper en segments compatibles Polly
    const segments = chunkText(fullText, 3000);

    // 4. Générer et collecter tous les buffers audio
    const audioBuffers = [];
    for (const segment of segments) {
      const { AudioStream } = await polly.send(new SynthesizeSpeechCommand({
        Text: segment,
        VoiceId: POLLY_VOICE_ID,
        OutputFormat: "mp3",
        Engine: "neural",
        TextType: "text",
        LexiconNames: ["LexiqueCN2i"]
      }));
      if (!AudioStream) throw new Error("Empty AudioStream from Polly");
      const buf = await streamToBuffer(AudioStream);
      audioBuffers.push(buf);
    }

    // 5. Concaténer tous les buffers en un seul MP3
    const finalBuffer = Buffer.concat(audioBuffers);

    // 6. Uploader le MP3 sur S3
    const key = `audio/${storyId}.mp3`;
    await s3.send(new PutObjectCommand({
      Bucket: AUDIO_BUCKET,
      Key: key,
      Body: finalBuffer,
      ContentType: "audio/mpeg"
    }));
    const audioUrl = `https://${AUDIO_BUCKET}.s3.${S3_BUCKET_REGION}.amazonaws.com/${key}`;

    // 7. Répondre avec l’URL
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
