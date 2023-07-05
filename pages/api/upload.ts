import type { NextApiRequest, NextApiResponse } from 'next';
import { MongoClient, Db, GridFSBucket } from 'mongodb';
import { IncomingForm } from 'formidable';
import fs from 'fs';
import { OpenAIApi, Configuration } from 'openai';
import { convertToHtml } from 'mammoth/mammoth.browser';
import path from 'path';

const { DocumentProcessorServiceClient } = require('@google-cloud/documentai').v1;

export const config = {
  api: {
    bodyParser: false,
  },
};

const connectToDatabase = async (): Promise<Db> => {
  const client = new MongoClient(process.env.MONGO_URI!);
  try {
    await client.connect();
    const db = client.db('Auth');
    return db;
  } catch (error) {
    console.error('Error connecting to database: ', error); // Added error logging
    throw error;
  }
};

const extractPdfContent = async (buffer: Buffer): Promise<string> => {
  // Initialize client
  const client = new DocumentProcessorServiceClient();

  // Add your Google Cloud project ID, location, and processor ID here
  const projectId = 'capable-bliss-378816';
  const location = 'us';
  const processorId = '9b70de812ae7194a';

  const name = `projects/${projectId}/locations/${location}/processors/${processorId}`;

  // Convert the buffer data to base64
  const encodedImage = Buffer.from(buffer).toString('base64');

  const request = {
    name,
    rawDocument: {
      content: encodedImage,
      mimeType: 'application/pdf',
    },
  };

  // Process the document
  const [result] = await client.processDocument(request);
  let { text } = result.document;

  // Trim middle white spaces
  text = text.replace(/\s+/g, ' ').trim();
  // Check if the last character is a period
  if (text && text.length > 0 && text[text.length - 1] !== '.') {
    // Append a period at the end
    text += '.';
  }
  return text;
};

const extractDocxContent = async (buffer: Buffer): Promise<string> => {
  const result = await convertToHtml({ arrayBuffer: buffer });

  if (result.messages.length > 0) {
    throw new Error('Error extracting content from .docx file');
  }
  return result.value;
};

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});

// Summarize the content using OpenAI
const summarizeContent = async (content: string, isDocx: boolean): Promise<string> => {
  let cleanedContent = content;

  // Remove the opening and closing paragraph tags
  if (isDocx) {
    cleanedContent = cleanedContent.slice(3, -4);
  }

  const prompt = `${cleanedContent} \n\nTl;dr`;
  console.log(prompt);

  // Create an instance of OpenAI with your API key
  const openai = new OpenAIApi(configuration);

  // Make a request to the OpenAI API to generate the summary
  const response = await openai.createCompletion({
    model: 'text-davinci-003', // Choose the appropriate OpenAI model
    prompt: prompt,
    max_tokens: 1000, // Adjust the maximum number of tokens as needed
    temperature: 0.7, // Adjust the temperature for controlling randomness
    n: 1, // Generate a single response
    stop: ['\n', '.', '!', '?'], // List of stop sequences
  });

  // Log the first choice object
  console.log(response.data.choices[0]);

  // Extract the summary from the response
  const summary = response.data.choices[0]?.text?.trim() || '';

  return summary;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'POST') {
    const data: any = await new Promise((resolve, reject) => {
      const form = new IncomingForm();

      form.parse(req, (err, fields, files) => {
        if (err) {
          console.error('Error parsing form data:', err);
          reject(err);
          return;
        }
        console.log(files); // log the files object
        resolve({ fields, files });
      });

      // Reject the promise after 5 seconds
      setTimeout(() => reject(new Error('Form parse timeout')), 5000);
    });

    try {
      const db = await connectToDatabase();
      const bucket = new GridFSBucket(db);

      // Assuming only one file is uploaded at a time
      const file = data.files.file[0]; // access the first file in the array
      const readStream = fs.createReadStream(file.filepath); // use `filepath` instead of `path`
      const uploadStream = bucket.openUploadStream(file.originalFilename); // use `originalFilename` instead of `name`

      // Attach the email field to the file metadata
      uploadStream.options.metadata = {
        email: data.fields.email || '', // Provide a default value if email is undefined
      };

      readStream.pipe(uploadStream);

      uploadStream.on('finish', async (file: any) => {
        try {
          const fileContent: any = [];
          let isDocx: boolean = true;
          const readStream = bucket.openDownloadStream(file._id);
          readStream.on('data', (chunk) => {
            fileContent.push(chunk);
          });
          readStream.on('end', async () => {
            const buffer = Buffer.concat(fileContent);

            // you use the file's original file name to determine its extension
            const extension = path.extname(file.filename).slice(1); // slice(1) removes the leading '.'
            let textContent = '';

            // Then, you use the extension to determine how to extract the text
            // Note: you might want to handle the case where the extension is neither 'pdf' nor 'docx'
            if (extension === 'pdf') {
              textContent = await extractPdfContent(buffer);
              isDocx = false;
            } else if (extension === 'docx') {
              textContent = await extractDocxContent(buffer);
            } else {
              throw new Error('Unsupported file type');
            }
            const summary = await summarizeContent(textContent, isDocx);
            res.status(200).json({ message: 'File uploaded and summarized successfully', summary });
            return;
          });
        } catch (error) {
          res.status(500).json({ error: 'Error summarizing file content' });
        }
      });

      uploadStream.on('error', (error) => {
        res.status(500).json({ error: 'Error uploading file' });
      });
    } catch (error) {
      res.status(500).json({ error: 'Error connecting to the database' });
    }
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
}
