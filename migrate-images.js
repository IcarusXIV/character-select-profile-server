// ============================================================================
// IMAGE OPTIMIZATION MIGRATION SCRIPT
// ============================================================================
// One-time batch processor that re-encodes existing profile images using the
// same pipeline as the live upload handler: PNG → JPEG q95 for images without
// alpha, PNG re-compressed for images with alpha. Preserves original dimensions
// (no resize), strips EXIF. Typical result: ~85-95% size reduction on PNG
// sources with no perceptible quality loss.
//
// Safety features:
//   1. Full backup copy of imagesDir → imagesDir.bak before any writes
//   2. Dry-run mode (--dry-run) reports what would change without writing
//   3. Never deletes the original until the new file is written AND verified
//   4. Resumable, checkpoints after every 100 files, skips already-done
//   5. Progress logging with running totals
//   6. Updates profile JSONs to point at the new URL when extension changes
//
// Usage:
//   node migrate-images.js --dry-run                  # Report, don't write
//   node migrate-images.js --dry-run --limit=500      # Dry-run first 500
//   node migrate-images.js                            # Full run
//   node migrate-images.js --resume                   # Continue from checkpoint
//   node migrate-images.js --no-backup                # Skip backup (NOT recommended)
// ============================================================================

const fs = require("fs");
const path = require("path");

let sharp;
try {
    sharp = require("sharp");
} catch (err) {
    console.error("❌ sharp is required. Run: npm install sharp");
    process.exit(1);
}

// ----------------------------------------------------------------------------
// Config, must match the live upload handler settings
// ----------------------------------------------------------------------------
const JPEG_QUALITY = 95;
const PNG_COMPRESSION = 9;
const MIN_SIZE_WIN = 0.05;

const DATA_DIR = process.env.NODE_ENV === "production" ? "/app/data" : __dirname;
const imagesDir = path.join(DATA_DIR, "public", "images");
const backupDir = imagesDir + ".bak";
const profilesDir = path.join(DATA_DIR, "profiles");
const checkpointFile = path.join(DATA_DIR, ".migrate-images-checkpoint");

// ----------------------------------------------------------------------------
// CLI flags
// ----------------------------------------------------------------------------
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const RESUME = argv.includes("--resume");
const NO_BACKUP = argv.includes("--no-backup");
const LIMIT = (() => {
    const arg = argv.find(a => a.startsWith("--limit="));
    return arg ? parseInt(arg.split("=")[1], 10) : 0;
})();

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function formatBytes(n) {
    if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + " MB";
    if (n >= 1024) return (n / 1024).toFixed(2) + " KB";
    return n + " B";
}

function formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m " + (s % 60) + "s";
    const h = Math.floor(m / 60);
    return h + "h " + (m % 60) + "m";
}

async function backupImagesDir() {
    if (NO_BACKUP) {
        console.log("⚠️  --no-backup: skipping backup (you're on your own)");
        return;
    }
    if (fs.existsSync(backupDir)) {
        console.log(`✅ Backup already exists at ${backupDir}, reusing`);
        return;
    }
    console.log(`📦 Backing up ${imagesDir} → ${backupDir} (this may take a few minutes for 244 GB)...`);
    const startTime = Date.now();

    // Recursive copy using Node's fs.cp (Node 16.7+)
    await fs.promises.cp(imagesDir, backupDir, { recursive: true });

    const elapsed = Date.now() - startTime;
    console.log(`✅ Backup complete in ${formatDuration(elapsed)}`);
}

function loadCheckpoint() {
    if (!RESUME) return new Set();
    if (!fs.existsSync(checkpointFile)) return new Set();
    try {
        const data = fs.readFileSync(checkpointFile, "utf-8");
        return new Set(data.split("\n").filter(Boolean));
    } catch (err) {
        console.error("⚠️  Failed to load checkpoint, starting fresh:", err.message);
        return new Set();
    }
}

function saveCheckpoint(processedSet) {
    try {
        fs.writeFileSync(checkpointFile, [...processedSet].join("\n"));
    } catch (err) {
        console.error("⚠️  Failed to save checkpoint:", err.message);
    }
}

// ----------------------------------------------------------------------------
// Core optimization, mirrors the live upload pipeline exactly
// ----------------------------------------------------------------------------
async function optimizeOne(filename) {
    const fullPath = path.join(imagesDir, filename);
    let originalSize;
    try {
        originalSize = (await fs.promises.stat(fullPath)).size;
    } catch (err) {
        return { status: "error", filename, error: "stat failed: " + err.message };
    }

    let metadata;
    try {
        metadata = await sharp(fullPath, { failOn: "error" }).metadata();
    } catch (err) {
        return { status: "error", filename, error: "metadata probe failed: " + err.message, originalSize };
    }

    const hasAlpha = metadata.hasAlpha === true;
    const targetExt = hasAlpha ? ".png" : ".jpg";
    const baseName = path.basename(filename, path.extname(filename));
    const targetFilename = baseName + targetExt;
    const targetPath = path.join(imagesDir, targetFilename);
    const tempPath = targetPath + ".opt.tmp";

    // If the optimized version already exists (previous run), skip
    if (filename !== targetFilename && fs.existsSync(targetPath)) {
        return { status: "skipped", filename, reason: "target already exists", originalSize };
    }

    try {
        let pipeline = sharp(fullPath).rotate();

        if (hasAlpha) {
            pipeline = pipeline.png({ compressionLevel: PNG_COMPRESSION, palette: false });
        } else {
            pipeline = pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: true, progressive: true });
        }

        pipeline = pipeline.withMetadata({ exif: {}, icc: undefined, iptc: {}, xmp: "" });

        await pipeline.toFile(tempPath);

        // Verify output
        const verifyMeta = await sharp(tempPath).metadata();
        if (!verifyMeta.width || !verifyMeta.height) {
            try { fs.unlinkSync(tempPath); } catch (e) { /* ignore */ }
            return { status: "error", filename, error: "output failed decode verification", originalSize };
        }

        const newSize = (await fs.promises.stat(tempPath)).size;

        // Only adopt if meaningfully smaller
        if (newSize >= originalSize * (1 - MIN_SIZE_WIN)) {
            try { fs.unlinkSync(tempPath); } catch (e) { /* ignore */ }
            return { status: "skipped", filename, reason: "no meaningful size win", originalSize, newSize };
        }

        if (DRY_RUN) {
            try { fs.unlinkSync(tempPath); } catch (e) { /* ignore */ }
            return {
                status: "would-migrate",
                filename,
                targetFilename,
                originalSize,
                newSize,
                savedBytes: originalSize - newSize,
                extensionChanged: filename !== targetFilename
            };
        }

        // Commit: rename temp → target
        fs.renameSync(tempPath, targetPath);

        // If extension changed, delete the original (different filename)
        if (filename !== targetFilename) {
            try { fs.unlinkSync(fullPath); } catch (e) { /* ignore */ }
            // Update any profile JSON that references the old filename
            await updateProfileImageUrl(baseName, filename, targetFilename);
        }

        return {
            status: "migrated",
            filename,
            targetFilename,
            originalSize,
            newSize,
            savedBytes: originalSize - newSize,
            extensionChanged: filename !== targetFilename
        };
    } catch (err) {
        try { fs.unlinkSync(tempPath); } catch (e) { /* ignore */ }
        return { status: "error", filename, error: err.message, originalSize };
    }
}

// ----------------------------------------------------------------------------
// Profile JSON URL update (only fires when extension changes e.g. .png → .jpg)
// ----------------------------------------------------------------------------
async function updateProfileImageUrl(characterId, oldFilename, newFilename) {
    // Profile JSON filename matches the image's base name (characterId)
    const profilePath = path.join(profilesDir, characterId + ".json");
    if (!fs.existsSync(profilePath)) return;

    try {
        const raw = await fs.promises.readFile(profilePath, "utf-8");
        const profile = JSON.parse(raw);
        if (!profile.ProfileImageUrl) return;
        if (!profile.ProfileImageUrl.includes(oldFilename)) return;

        profile.ProfileImageUrl = profile.ProfileImageUrl.replace(oldFilename, newFilename);
        profile.LastUpdated = new Date().toISOString();

        const tempPath = profilePath + ".tmp";
        await fs.promises.writeFile(tempPath, JSON.stringify(profile, null, 2));
        fs.renameSync(tempPath, profilePath);
    } catch (err) {
        console.error(`  ⚠️  Failed to update profile URL for ${characterId}: ${err.message}`);
    }
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------
async function main() {
    const startTime = Date.now();

    console.log("=".repeat(70));
    console.log("IMAGE OPTIMIZATION MIGRATION");
    console.log("=".repeat(70));
    console.log(`Mode:        ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE"}`);
    console.log(`Images dir:  ${imagesDir}`);
    console.log(`Profiles:    ${profilesDir}`);
    console.log(`Resume:      ${RESUME ? "yes" : "no (fresh start)"}`);
    console.log(`Backup:      ${NO_BACKUP ? "SKIPPED (dangerous)" : DRY_RUN ? "skipped (dry run)" : "enabled"}`);
    console.log(`Limit:       ${LIMIT > 0 ? LIMIT : "none"}`);
    console.log("");

    if (!fs.existsSync(imagesDir)) {
        console.error(`❌ Images directory not found: ${imagesDir}`);
        process.exit(1);
    }

    // Backup BEFORE any writes (skipped in dry-run)
    if (!DRY_RUN) {
        await backupImagesDir();
    }

    // Enumerate source files
    const allFiles = fs.readdirSync(imagesDir).filter(f =>
        /\.(png|jpe?g|webp|gif|tiff?|bmp)$/i.test(f) && !f.endsWith(".opt.tmp")
    );
    console.log(`📂 Found ${allFiles.length.toLocaleString()} image files in source directory`);

    const processed = loadCheckpoint();
    if (processed.size > 0) {
        console.log(`📌 Resuming: ${processed.size.toLocaleString()} already processed`);
    }

    const pending = allFiles.filter(f => !processed.has(f));
    const targets = LIMIT > 0 ? pending.slice(0, LIMIT) : pending;

    console.log(`🎯 Will process ${targets.length.toLocaleString()} files\n`);

    if (targets.length === 0) {
        console.log("✨ Nothing to do");
        return;
    }

    // Stats
    let migrated = 0;
    let skipped = 0;
    let errors = 0;
    let totalOriginalBytes = 0;
    let totalNewBytes = 0;
    let totalSavedBytes = 0;

    for (let i = 0; i < targets.length; i++) {
        const filename = targets[i];
        const result = await optimizeOne(filename);

        if (result.status === "migrated" || result.status === "would-migrate") {
            migrated++;
            totalOriginalBytes += result.originalSize;
            totalNewBytes += result.newSize;
            totalSavedBytes += result.savedBytes;
        } else if (result.status === "skipped") {
            skipped++;
            if (result.originalSize) totalOriginalBytes += result.originalSize;
        } else if (result.status === "error") {
            errors++;
            console.error(`  ❌ ${filename}: ${result.error}`);
        }

        // Checkpoint every 100 files (skip in dry-run)
        if (!DRY_RUN) {
            processed.add(filename);
            if (i % 100 === 0) {
                saveCheckpoint(processed);
            }
        }

        // Progress log every 100 files
        if ((i + 1) % 100 === 0 || i === targets.length - 1) {
            const pct = (((i + 1) / targets.length) * 100).toFixed(1);
            const elapsed = Date.now() - startTime;
            const rate = (i + 1) / (elapsed / 1000);
            const remaining = (targets.length - (i + 1)) / rate * 1000;
            console.log(
                `[${pct.padStart(5)}%] ${i + 1}/${targets.length}, ` +
                `migrated: ${migrated}, skipped: ${skipped}, errors: ${errors}, ` +
                `saved: ${formatBytes(totalSavedBytes)}, ` +
                `ETA: ${formatDuration(remaining)}`
            );
        }

        // Yield to event loop occasionally so the process stays responsive
        if (i % 25 === 0) {
            await new Promise(r => setTimeout(r, 10));
        }
    }

    // Final checkpoint
    if (!DRY_RUN) {
        saveCheckpoint(processed);
    }

    const totalElapsed = Date.now() - startTime;

    console.log("\n" + "=".repeat(70));
    console.log("MIGRATION SUMMARY");
    console.log("=".repeat(70));
    console.log(`Mode:             ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE"}`);
    console.log(`Duration:         ${formatDuration(totalElapsed)}`);
    console.log(`Files processed:  ${targets.length.toLocaleString()}`);
    console.log(`  Migrated:       ${migrated.toLocaleString()}`);
    console.log(`  Skipped:        ${skipped.toLocaleString()}`);
    console.log(`  Errors:         ${errors.toLocaleString()}`);
    console.log("");
    console.log(`Total original:   ${formatBytes(totalOriginalBytes)}`);
    console.log(`Total new:        ${formatBytes(totalNewBytes)}`);
    console.log(`Total saved:      ${formatBytes(totalSavedBytes)}`);
    if (totalOriginalBytes > 0) {
        const overallReduction = ((totalSavedBytes / totalOriginalBytes) * 100).toFixed(1);
        console.log(`Overall reduction: ${overallReduction}%`);
    }
    console.log("");
    if (DRY_RUN) {
        console.log("👉 This was a dry run. Re-run without --dry-run to apply changes.");
    } else {
        console.log(`👉 Backup preserved at: ${backupDir}`);
        console.log(`👉 Rollback: rm -rf ${imagesDir} && mv ${backupDir} ${imagesDir}`);
    }
}

main().catch(err => {
    console.error("❌ Fatal error:", err);
    process.exit(1);
});
