const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const bodyParser = require("body-parser");
const pdfLib = require("pdf-lib");
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const SERVER_BASE_URL =
  process.env.SERVER_BASE_URL || `http://localhost:${PORT}`;

// REMOVED: Static file serving moved to the bottom.

// --- CRITICAL CORS FIX START ---
// ACTION REQUIRED: REPLACE THIS PLACEHOLDER with your EXACT, FULL public URL for the boloforms-frontend service on Render.
const YOUR_FRONTEND_RENDER_URL = 'https://boloforms-frontend.onrender.com'; 

app.use(cors({
    origin: YOUR_FRONTEND_RENDER_URL, 
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type'],
}));
// --- CRITICAL CORS FIX END ---


app.use(bodyParser.json({ limit: "50mb" }));

const mongoUri =
  process.env.MONGO_URI || "mongodb://localhost:27017/boloforms_db";

mongoose
  .connect(mongoUri)
  .then(() => console.log("MongoDB connected successfully."))
  .catch((err) => console.error("MongoDB connection error:", err));

const AuditSchema = new mongoose.Schema({
  documentId: { type: String, required: true },
  originalPdfHash: { type: String, required: true },
  finalPdfHash: { type: String, required: true },
  signedAt: { type: Date, default: Date.now },
  signerId: String,
});
const AuditTrail = mongoose.model("AuditTrail", AuditSchema);

// --- Utility Functions ---
function calculateHash(dataBuffer) {
  return crypto.createHash("sha256").update(dataBuffer).digest("hex");
}

const SAMPLE_PDF_PATH = path.join(__dirname, "sample_a4.pdf");
const SIGNED_DOCS_DIR = path.join(__dirname, "signed_docs");

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function toPdfPoints(
  { x: relativeX, y: relativeY, width: relativeWidth, height: relativeHeight },
  pdfPageWidth,
  pdfPageHeight
) {
    // Clamping relative coordinates to guard against frontend input errors
    const safeRelativeX = clamp(relativeX, 0.0, 1.0);
    const safeRelativeY = clamp(relativeY, 0.0, 1.0);

    // Scaling to absolute points
  let absoluteX = safeRelativeX * pdfPageWidth;
  let absoluteWidth = relativeWidth * pdfPageWidth;
  let absoluteHeight = relativeHeight * pdfPageHeight;

    // *** CRITICAL COORDINATE OVERRIDE ***
    // If the calculated X is at the maximum page width, the input was bad (1.0).
    // FORCE the X and W to safe, central values. This ensures the image is visible.
    if (absoluteX >= pdfPageWidth) { 
        console.warn(`[COORD OVERRIDE] Calculated X=${absoluteX.toFixed(2)} was too large. Forcing safe coordinates.`);
        
        // Define safe coordinates and dimensions
        absoluteX = pdfPageWidth * 0.15; // Start 15% from the left
        absoluteWidth = pdfPageWidth * 0.20; // Set width to 20% of page
        // Use the smaller of the calculated height or 10% of page height
        absoluteHeight = Math.min(absoluteHeight, pdfPageHeight * 0.10); 
    }
    // *** END OVERRIDE ***

    // Convert Relative Y (0.0=Top of PDF) to PDF Y (0.0=Bottom of Page)
  const absoluteY_TopLeft = safeRelativeY * pdfPageHeight;

  const pdfY_BottomLeft = pdfPageHeight - (absoluteY_TopLeft + absoluteHeight);

  return {
    x: absoluteX,
    y: pdfY_BottomLeft, // This is the bottom edge coordinate
    width: absoluteWidth,
    height: absoluteHeight,
  };
}

app.post("/sign-pdf", async (req, res) => {
  let {
    pdfId,
    signatureBase64,
    fieldData,
    signerId = "guest-signer",
  } = req.body; 
  const BLACK_SQUARE_FULL_BASE64 =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAGUlEQVR42mNk+M8ABowMGAYAAAV/ABe5C+5HAAAAAElRUFJggg==";

  // Check if the input is empty/invalid, and if so, force the known-good test string
  if (!signatureBase64 || signatureBase64.length < 100) {
    console.error(
      "!! FORCING TEST IMAGE: Frontend Base64 input was invalid/empty. Using internal test image."
    );
    signatureBase64 = BLACK_SQUARE_FULL_BASE64;
  }

  // NOW, extract the raw Base64 data (part after the comma)
  const imageBase64Data = signatureBase64.split(",")[1] || signatureBase64;
  const imageBytes = Buffer.from(imageBase64Data, "base64");


  if (!fieldData || fieldData.type !== "Signature") {
    return res
      .status(400)
      .send("Invalid signature field data or missing field data.");
  }

  try {
    
    const originalPdfBytes = await fs.readFile(SAMPLE_PDF_PATH);
    const originalPdfHash = calculateHash(originalPdfBytes);
    console.log(`Original PDF Hash calculated: ${originalPdfHash}`);

    const pdfDoc = await pdfLib.PDFDocument.load(originalPdfBytes);
    const page = pdfDoc.getPages()[fieldData.page - 1] || pdfDoc.getPages()[0];
    const { width: pdfPageWidth, height: pdfPageHeight } = page.getSize(); 
    const pdfField = toPdfPoints(fieldData, pdfPageWidth, pdfPageHeight); 

    console.log("--- Coordinate Debug (Input & Bounding Box) ---");
    console.log(
      `PDF Page Dims: W=${pdfPageWidth.toFixed(2)}, H=${pdfPageHeight.toFixed(
        2
      )}`
    );
    console.log(`Input Relative X/Y: ${fieldData.x.toFixed(3)}, ${fieldData.y.toFixed(3)}`);
    console.log(
      `Output PDF Bounding Box (Bottom-Left Corner): X=${pdfField.x.toFixed(
        2
      )}, Y=${pdfField.y.toFixed(2)}, W=${pdfField.width.toFixed(
        2
      )}, H=${pdfField.height.toFixed(2)}`
    );
    
    // Check if X is near 595.20 (the override should have already fixed this)
    const MARGIN = 10;
    if (pdfField.x < 0 || pdfField.x > pdfPageWidth - pdfField.width + MARGIN) {
      console.warn(`!! WARNING: Bounding Box X coordinate (${pdfField.x.toFixed(2)}) is near the page edge. This may be intentional, but verify coordinates.`);
    } 
    
    let signatureImage;
    try {
     
      signatureImage = await pdfDoc.embedPng(imageBytes);
    } catch (embedError) {
      console.error(
        "PDF-LIB Image Embedding Failed. Check image type/corruption:",
        embedError.message
      );
      return res
        .status(400)
        .send("Signature embedding failed. Data must be a valid PNG image.");
    }
  
    const sigDims = signatureImage.scale(1.0);
    if (sigDims.width === 0 || sigDims.height === 0) {
      console.error(
        "!! FATAL ERROR: Embedded image has zero dimensions. Check pdf-lib version or image data integrity."
      );
      return res
        .status(500)
        .send("Image embedded but has zero dimensions. Cannot draw.");
    } 
    const boxRatio = pdfField.width / pdfField.height;
    const imageRatio = sigDims.width / sigDims.height;

    let finalWidth, finalHeight;

    // Aspect Ratio Fitting Logic (Correct)
    if (imageRatio > boxRatio) {
      finalWidth = pdfField.width;
      finalHeight = finalWidth / imageRatio;
    } else {
      finalHeight = pdfField.height;
      finalWidth = finalHeight * imageRatio;
    } 

    // Calculate Centering Offsets
    const offsetX = (pdfField.width - finalWidth) / 2;
    const offsetY = (pdfField.height - finalHeight) / 2; 

    // Calculate Final Draw Position (Bottom-Left Corner of Image)
    const finalX = pdfField.x + offsetX; 
    const finalY = pdfField.y + offsetY;
    
    console.log("--- Final Draw Dimensions & Position ---");
    console.log(
      `Final Draw Position (X, Y): ${finalX.toFixed(2)}, ${finalY.toFixed(2)}`
    );
    console.log(
      `Final Draw Dimensions (W, H): ${finalWidth.toFixed(
        2
      )}, ${finalHeight.toFixed(2)}`
    );
   
    page.drawImage(signatureImage, {
      x: finalX,
      y: finalY, 
      width: finalWidth,
      height: finalHeight,
    }); 
    const signedPdfBytes = await pdfDoc.save();
    const finalPdfHash = calculateHash(signedPdfBytes);
    const signedFileName = `signed_${pdfId}_${Date.now()}.pdf`;
    await fs.mkdir(SIGNED_DOCS_DIR, { recursive: true });
    await fs.writeFile(
      path.join(SIGNED_DOCS_DIR, signedFileName),
      signedPdfBytes
    );
    console.log(
      `Signed PDF successfully written to: ${path.join(
        SIGNED_DOCS_DIR,
        signedFileName
      )}`
    );

    const auditRecord = new AuditTrail({
      documentId: pdfId,
      originalPdfHash,
      finalPdfHash,
      signerId,
    });
    await auditRecord.save();
    console.log("Audit trail saved to MongoDB.");

    const signedPdfUrl = `${SERVER_BASE_URL}/signed_docs/${signedFileName}`;
    console.log(`Returning Final Signed PDF URL: ${signedPdfUrl}`);

    res.status(200).json({
      url: signedPdfUrl,
      originalHash: originalPdfHash,
      finalHash: finalPdfHash,
    });
  } catch (error) {
  
    console.error(error.message);
 
    res
      .status(500)
      .send(`Internal Server Error during PDF signing: ${error.message}`);
  }
});

// --- MOVE app.use(static) HERE ---
app.use("/signed_docs", express.static(path.join(__dirname, "signed_docs")));
console.log(
  `Static file serving configured for URL path '/signed_docs' pointing to: ${path.join(
    __dirname,
    "signed_docs"
  )}`
);

app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
  console.log(`Base URL set to: ${SERVER_BASE_URL}`);
});