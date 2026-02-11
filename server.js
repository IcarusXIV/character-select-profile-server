const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// ===============================
// 🚀 RAILWAY VOLUME SETUP
// ===============================
// Use mounted volume in production, local directory in development
const DATA_DIR = process.env.NODE_ENV === 'production' ? '/app/data' : __dirname;
console.log(`📁 Using data directory: ${DATA_DIR}`);

// Create directories if they don't exist
const profilesDir = path.join(DATA_DIR, "profiles");
if (!fs.existsSync(profilesDir)) fs.mkdirSync(profilesDir, { recursive: true });

const imagesDir = path.join(DATA_DIR, "public", "images");
if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });

// Create uploads directory within the volume to avoid cross-device issues
const uploadsDir = path.join(DATA_DIR, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Static route to serve uploaded images
app.use("/images", express.static(path.join(DATA_DIR, "public", "images")));

const upload = multer({ dest: uploadsDir });

// Gallery caching
let galleryCache = null;
let galleryCacheTime = 0;
let galleryCacheBuilding = false;
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes cache - extended for 24k+ profiles

// All Profiles caching (admin endpoint)
let allProfilesCache = null;
let allProfilesCacheTime = 0;
let allProfilesCacheBuilding = false;

// Names lookup caching - indexed by physical character name
let namesCache = null;           // Map<physicalName, {csName, nameplateColor}>
let namesCacheTime = 0;
let namesCacheBuilding = false;  // Prevent concurrent rebuilds
const NAMES_CACHE_DURATION = 30 * 60 * 1000; // 30 minutes - extended for 24k+ profiles

// RP Profiles lookup caching - tracks who has shared profiles (for context menu)
let profilesLookupCache = null;  // Set<physicalName> - users with shared profiles
let profilesLookupCacheTime = 0;
let profilesLookupCacheBuilding = false;
const PROFILES_LOOKUP_CACHE_DURATION = 30 * 60 * 1000; // 30 minutes - extended for 24k+ profiles

app.use(require('compression')());
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

// Handle aborted requests silently (client disconnect during upload)
app.use((req, res, next) => {
    req.on('aborted', () => {
        // Silently ignore - don't log spam
    });
    next();
});

// Database files - ALL NOW PERSISTENT WITH VOLUMES
const likesDbFile = path.join(DATA_DIR, "likes_database.json");
const friendsDbFile = path.join(DATA_DIR, "friends_database.json");
const announcementsDbFile = path.join(DATA_DIR, "announcements_database.json");
const reportsDbFile = path.join(DATA_DIR, "reports_database.json");
const moderationDbFile = path.join(DATA_DIR, "moderation_database.json");
const activityDbFile = path.join(DATA_DIR, "activity_database.json");
const flaggedDbFile = path.join(DATA_DIR, "flagged_database.json");

// 💾 DATABASE CLASSES
class LikesDatabase {
    constructor() {
        this.likes = new Map();
        this.likeCounts = new Map();
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(likesDbFile)) {
                const data = JSON.parse(fs.readFileSync(likesDbFile, 'utf-8'));
                this.likes = new Map(data.likes.map(([k, v]) => [k, new Set(v)]));
                this.likeCounts = new Map(data.likeCounts);
                console.log(`💾 Loaded ${this.likeCounts.size} like records`);
            }
        } catch (err) {
            console.error('Error loading likes database:', err);
            this.likes = new Map();
            this.likeCounts = new Map();
        }
    }

    save() {
        try {
            const data = {
                likes: Array.from(this.likes.entries()).map(([k, v]) => [k, Array.from(v)]),
                likeCounts: Array.from(this.likeCounts.entries()),
                lastSaved: new Date().toISOString()
            };
            
            const tempFile = likesDbFile + '.tmp';
            fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
            
            if (fs.existsSync(likesDbFile)) {
                fs.copyFileSync(likesDbFile, likesDbFile + '.backup');
            }
            
            fs.renameSync(tempFile, likesDbFile);
        } catch (err) {
            console.error('Error saving likes database:', err);
        }
    }

    addLike(characterId, likerId) {
        if (!this.likes.has(characterId)) {
            this.likes.set(characterId, new Set());
        }
        
        const wasNew = !this.likes.get(characterId).has(likerId);
        if (wasNew) {
            this.likes.get(characterId).add(likerId);
            this.likeCounts.set(characterId, (this.likeCounts.get(characterId) || 0) + 1);
            this.save();
        }
        return this.likeCounts.get(characterId) || 0;
    }

    removeLike(characterId, likerId) {
        if (this.likes.has(characterId)) {
            const wasRemoved = this.likes.get(characterId).delete(likerId);
            if (wasRemoved) {
                const newCount = Math.max(0, (this.likeCounts.get(characterId) || 0) - 1);
                this.likeCounts.set(characterId, newCount);
                this.save();
                return newCount;
            }
        }
        return this.likeCounts.get(characterId) || 0;
    }

    getLikeCount(characterId) {
        return this.likeCounts.get(characterId) || 0;
    }
}

class FriendsDatabase {
    constructor() {
        this.friends = new Map();
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(friendsDbFile)) {
                const data = JSON.parse(fs.readFileSync(friendsDbFile, 'utf-8'));
                this.friends = new Map(data.friends.map(([k, v]) => [k, new Set(v)]));
                console.log(`🤝 Loaded ${this.friends.size} friend records`);
            }
        } catch (err) {
            console.error('Error loading friends database:', err);
            this.friends = new Map();
        }
    }

    save() {
        try {
            const data = {
                friends: Array.from(this.friends.entries()).map(([k, v]) => [k, Array.from(v)]),
                lastSaved: new Date().toISOString()
            };
            
            const tempFile = friendsDbFile + '.tmp';
            fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
            
            if (fs.existsSync(friendsDbFile)) {
                fs.copyFileSync(friendsDbFile, friendsDbFile + '.backup');
            }
            
            fs.renameSync(tempFile, friendsDbFile);
        } catch (err) {
            console.error('Error saving friends database:', err);
        }
    }

    updateFriends(characterId, friendsList) {
        this.friends.set(characterId, new Set(friendsList));
        this.save();
    }

    getFriends(characterId) {
        return Array.from(this.friends.get(characterId) || []);
    }

    getMutualFriends(characterId) {
        const myFriends = this.friends.get(characterId) || new Set();
        const mutuals = [];
        
        for (const friendId of myFriends) {
            const theirFriends = this.friends.get(friendId) || new Set();
            if (theirFriends.has(characterId)) {
                mutuals.push(friendId);
            }
        }
        
        return mutuals;
    }
}

class AnnouncementsDatabase {
    constructor() {
        this.announcements = [];
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(announcementsDbFile)) {
                const data = JSON.parse(fs.readFileSync(announcementsDbFile, 'utf-8'));
                this.announcements = data.announcements || [];
                console.log(`📢 Loaded ${this.announcements.length} announcements`);
            }
        } catch (err) {
            console.error('Error loading announcements database:', err);
            this.announcements = [];
        }
    }

    save() {
        try {
            const data = {
                announcements: this.announcements,
                lastSaved: new Date().toISOString()
            };
            
            const tempFile = announcementsDbFile + '.tmp';
            fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
            
            if (fs.existsSync(announcementsDbFile)) {
                fs.copyFileSync(announcementsDbFile, announcementsDbFile + '.backup');
            }
            
            fs.renameSync(tempFile, announcementsDbFile);
        } catch (err) {
            console.error('Error saving announcements database:', err);
        }
    }

    addAnnouncement(title, message, type = 'info') {
        const announcement = {
            id: crypto.randomUUID(),
            title,
            message,
            type,
            createdAt: new Date().toISOString(),
            active: true
        };
        
        this.announcements.unshift(announcement);
        this.save();
        console.log(`📢 Added announcement: ${title}`);
        return announcement;
    }

    getActiveAnnouncements() {
        return this.announcements.filter(a => a.active);
    }

    getAllAnnouncements() {
        return this.announcements;
    }

    deactivateAnnouncement(id) {
        const announcement = this.announcements.find(a => a.id === id);
        if (announcement) {
            announcement.active = false;
            this.save();
            return true;
        }
        return false;
    }

    deleteAnnouncement(id) {
        const index = this.announcements.findIndex(a => a.id === id);
        if (index !== -1) {
            this.announcements.splice(index, 1);
            this.save();
            return true;
        }
        return false;
    }
}

class ReportsDatabase {
    constructor() {
        this.reports = [];
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(reportsDbFile)) {
                const data = JSON.parse(fs.readFileSync(reportsDbFile, 'utf-8'));
                this.reports = data.reports || [];
                console.log(`🚨 Loaded ${this.reports.length} reports`);
            }
        } catch (err) {
            console.error('Error loading reports database:', err);
            this.reports = [];
        }
    }

    save() {
        try {
            const data = {
                reports: this.reports,
                lastSaved: new Date().toISOString()
            };
            
            const tempFile = reportsDbFile + '.tmp';
            fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
            
            if (fs.existsSync(reportsDbFile)) {
                fs.copyFileSync(reportsDbFile, reportsDbFile + '.backup');
            }
            
            fs.renameSync(tempFile, reportsDbFile);
        } catch (err) {
            console.error('Error saving reports database:', err);
        }
    }

    addReport(reportedCharacterId, reportedCharacterName, reporterCharacter, reason, details, offensiveCSName = null) {
        const report = {
            id: crypto.randomUUID(),
            reportedCharacterId,
            reportedCharacterName,
            offensiveCSName,
            reporterCharacter,
            reason,
            details,
            status: 'pending',
            createdAt: new Date().toISOString(),
            reviewedAt: null,
            reviewedBy: null,
            adminNotes: null
        };

        this.reports.unshift(report);
        this.save();
        console.log(`🚨 New report: ${reportedCharacterName} (CS+ name: ${offensiveCSName || 'N/A'}) reported for ${reason}`);
        return report;
    }

    getReports(status = null) {
        if (status) {
            return this.reports.filter(r => r.status === status);
        }
        return this.reports;
    }

    updateReportStatus(reportId, status, adminNotes = null, adminId = 'admin') {
        const report = this.reports.find(r => r.id === reportId);
        if (report) {
            report.status = status;
            report.reviewedAt = new Date().toISOString();
            report.reviewedBy = adminId;
            report.adminNotes = adminNotes;
            this.save();
            return true;
        }
        return false;
    }
}

class ModerationDatabase {
    constructor() {
        this.actions = [];
        this.bannedProfiles = new Set();
        this.bannedUsers = new Set(); // Physical names banned from ALL uploads (user-level ban)
        this.nameBannedUsers = new Set(); // Physical names banned from CS+ Names feature
        this.nameWarnings = []; // Warning records for the 3-strike system
        this.userStrikeCounts = new Map(); // physicalName -> strike count
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(moderationDbFile)) {
                const data = JSON.parse(fs.readFileSync(moderationDbFile, 'utf-8'));
                this.actions = data.actions || [];
                this.bannedProfiles = new Set(data.bannedProfiles || []);
                this.bannedUsers = new Set(data.bannedUsers || []);
                this.nameBannedUsers = new Set(data.nameBannedUsers || []);
                this.nameWarnings = data.nameWarnings || [];
                this.userStrikeCounts = new Map(data.userStrikeCounts || []);
                console.log(`🛡️ Loaded ${this.actions.length} moderation actions, ${this.bannedProfiles.size} banned profiles, ${this.bannedUsers.size} banned users, ${this.nameBannedUsers.size} name-banned users, ${this.nameWarnings.length} name warnings`);
            }
        } catch (err) {
            console.error('Error loading moderation database:', err);
            this.actions = [];
            this.bannedProfiles = new Set();
            this.bannedUsers = new Set();
            this.nameBannedUsers = new Set();
            this.nameWarnings = [];
            this.userStrikeCounts = new Map();
        }
    }

    save() {
        try {
            const data = {
                actions: this.actions,
                bannedProfiles: Array.from(this.bannedProfiles),
                bannedUsers: Array.from(this.bannedUsers),
                nameBannedUsers: Array.from(this.nameBannedUsers),
                nameWarnings: this.nameWarnings,
                userStrikeCounts: Array.from(this.userStrikeCounts.entries()),
                lastSaved: new Date().toISOString()
            };

            const tempFile = moderationDbFile + '.tmp';
            fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));

            if (fs.existsSync(moderationDbFile)) {
                fs.copyFileSync(moderationDbFile, moderationDbFile + '.backup');
            }

            fs.renameSync(tempFile, moderationDbFile);
        } catch (err) {
            console.error('Error saving moderation database:', err);
        }
    }

    logAction(action, characterId, characterName, reason, adminId) {
        // Count repeated actions on the same profile
        const previousActions = this.actions.filter(a => 
            a.characterId === characterId && 
            a.action === action
        );
        const repeatCount = previousActions.length + 1;
        
        const moderationAction = {
            id: crypto.randomUUID(),
            action,
            characterId,
            characterName,
            reason,
            adminId,
            timestamp: new Date().toISOString(),
            repeatCount: repeatCount
        };
        
        this.actions.unshift(moderationAction);
        this.save();
        
        const repeatText = repeatCount > 1 ? ` (${repeatCount}x)` : '';
        console.log(`🛡️ Moderation: ${action} on ${characterName} by ${adminId}${repeatText}`);
        
        // Log to activity feed
        activityDB.logActivity('moderation', `${action.toUpperCase()}: ${characterName}${repeatText}`, {
            action,
            characterId,
            characterName,
            adminId,
            reason,
            repeatCount
        });
        
        return moderationAction;
    }

    banProfile(characterId) {
        this.bannedProfiles.add(characterId);
        // Also ban the physical user to prevent evasion by renaming CS+ character
        const physicalName = this.extractPhysicalName(characterId);
        if (physicalName) {
            this.bannedUsers.add(physicalName);
        }
        this.save();
    }

    unbanProfile(characterId) {
        this.bannedProfiles.delete(characterId);
        // Also unban the physical user
        const physicalName = this.extractPhysicalName(characterId);
        if (physicalName) {
            this.bannedUsers.delete(physicalName);
        }
        this.save();
    }

    // Extract physical name from characterId (format: "CSName_FirstName LastName@World")
    // CS+ names can contain underscores (special chars get sanitised to _),
    // so we find @ first and scan backwards to the _ separator
    extractPhysicalName(characterId) {
        const atIndex = characterId.lastIndexOf('@');
        if (atIndex <= 0) return null;

        // Physical name is "First Last@World" — find the space before @
        const beforeAt = characterId.substring(0, atIndex);
        const lastSpaceIndex = beforeAt.lastIndexOf(' ');
        if (lastSpaceIndex <= 0) return null;

        // Find the _ separator right before the physical first name
        const separatorIndex = beforeAt.lastIndexOf('_', lastSpaceIndex);
        if (separatorIndex < 0) return null;

        return characterId.substring(separatorIndex + 1);
    }

    isProfileBanned(characterId) {
        return this.bannedProfiles.has(characterId);
    }

    // User bans - prevents ALL uploads from a physical character
    banUser(physicalName) {
        this.bannedUsers.add(physicalName);
        this.save();
    }

    unbanUser(physicalName) {
        this.bannedUsers.delete(physicalName);
        this.save();
    }

    isUserBanned(physicalName) {
        return this.bannedUsers.has(physicalName);
    }

    getBannedUsers() {
        return Array.from(this.bannedUsers);
    }

    // Name bans - prevents CS+ name from showing to others
    banFromNames(physicalName) {
        this.nameBannedUsers.add(physicalName);
        this.save();
    }

    unbanFromNames(physicalName) {
        this.nameBannedUsers.delete(physicalName);
        this.save();
    }

    isNameBanned(physicalName) {
        return this.nameBannedUsers.has(physicalName);
    }

    getNameBannedUsers() {
        return Array.from(this.nameBannedUsers);
    }

    getActions() {
        return this.actions;
    }

    // ===== 3-STRIKE WARNING SYSTEM =====

    // Get current strike count for a user
    getUserStrikeCount(physicalName) {
        return this.userStrikeCounts.get(physicalName) || 0;
    }

    // Add a name warning (called when admin bans from names)
    // Returns the warning object with strike info
    addNameWarning(physicalName, offensiveCSName, adminId) {
        // Increment strike count
        const currentStrikes = this.getUserStrikeCount(physicalName);
        const newStrikeCount = currentStrikes + 1;
        this.userStrikeCounts.set(physicalName, newStrikeCount);

        // Determine status based on strike count
        let status;
        if (newStrikeCount >= 3) {
            status = 'permaban';
        } else if (newStrikeCount === 2) {
            status = 'warning2';
        } else {
            status = 'warning1';
        }

        const warning = {
            id: crypto.randomUUID(),
            physicalName,
            offensiveCSName,
            strikeNumber: newStrikeCount,
            status, // 'warning1', 'warning2', 'permaban'
            acknowledged: false,
            resolved: false, // true when they change name and it's approved
            adminId,
            createdAt: new Date().toISOString(),
            acknowledgedAt: null,
            resolvedAt: null,
            newCSName: null // set when they change their name
        };

        this.nameWarnings.unshift(warning);
        this.save();

        console.log(`⚠️ NAME WARNING #${newStrikeCount}: ${physicalName} (${offensiveCSName}) - Status: ${status}`);
        return warning;
    }

    // Get unacknowledged warnings for a user
    getUnacknowledgedWarnings(physicalName) {
        return this.nameWarnings.filter(w =>
            w.physicalName === physicalName &&
            !w.acknowledged
        );
    }

    // Get active (unresolved) warning for a user
    getActiveWarning(physicalName) {
        return this.nameWarnings.find(w =>
            w.physicalName === physicalName &&
            !w.resolved
        );
    }

    // Acknowledge a warning (user clicked the checkbox + accept)
    acknowledgeWarning(warningId) {
        const warning = this.nameWarnings.find(w => w.id === warningId);
        if (warning) {
            warning.acknowledged = true;
            warning.acknowledgedAt = new Date().toISOString();
            this.save();
            console.log(`✓ Warning acknowledged: ${warning.physicalName}`);
            return true;
        }
        return false;
    }

    // Called when user changes their CS+ name - check if it resolves a warning
    // Returns: { resolved: bool, needsReview: bool, warning: object }
    checkNameChange(physicalName, newCSName) {
        const activeWarning = this.getActiveWarning(physicalName);
        if (!activeWarning) {
            return { resolved: false, needsReview: false, warning: null };
        }

        // Name hasn't actually changed
        if (newCSName === activeWarning.offensiveCSName) {
            return { resolved: false, needsReview: false, warning: activeWarning };
        }

        // Record the new name
        activeWarning.newCSName = newCSName;

        if (activeWarning.status === 'warning1') {
            // First strike: auto-resolve
            activeWarning.resolved = true;
            activeWarning.resolvedAt = new Date().toISOString();
            this.unbanFromNames(physicalName);
            this.save();
            console.log(`✅ Warning auto-resolved: ${physicalName} changed name to ${newCSName}`);
            return { resolved: true, needsReview: false, warning: activeWarning };
        } else if (activeWarning.status === 'warning2') {
            // Second strike: needs review
            activeWarning.pendingReview = true;
            this.save();
            console.log(`🔍 Name change pending review: ${physicalName} -> ${newCSName}`);
            return { resolved: false, needsReview: true, warning: activeWarning };
        } else {
            // Permaban: no resolution possible
            return { resolved: false, needsReview: false, warning: activeWarning };
        }
    }

    // Admin approves a name change (for strike 2)
    approveNameChange(warningId) {
        const warning = this.nameWarnings.find(w => w.id === warningId);
        if (warning && warning.pendingReview) {
            warning.resolved = true;
            warning.resolvedAt = new Date().toISOString();
            warning.pendingReview = false;
            this.unbanFromNames(warning.physicalName);
            this.save();
            console.log(`✅ Name change approved: ${warning.physicalName}`);
            return true;
        }
        return false;
    }

    // Admin rejects a name change (for strike 2)
    rejectNameChange(warningId, reason) {
        const warning = this.nameWarnings.find(w => w.id === warningId);
        if (warning && warning.pendingReview) {
            warning.pendingReview = false;
            warning.newCSName = null; // Clear the rejected name
            warning.rejectionReason = reason;
            this.save();
            console.log(`❌ Name change rejected: ${warning.physicalName} - ${reason}`);
            return true;
        }
        return false;
    }

    // Get warnings pending review (strike 2 users who changed names)
    getPendingReviewWarnings() {
        return this.nameWarnings.filter(w => w.pendingReview === true);
    }

    // Get all warnings (for admin view)
    getAllNameWarnings() {
        return this.nameWarnings;
    }

    // Check if user is permanently banned from names
    isPermabanned(physicalName) {
        const warning = this.getActiveWarning(physicalName);
        return warning && warning.status === 'permaban';
    }
}

class ActivityDatabase {
    constructor() {
        this.activities = [];
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(activityDbFile)) {
                const data = JSON.parse(fs.readFileSync(activityDbFile, 'utf-8'));
                this.activities = data.activities || [];
                console.log(`📊 Loaded ${this.activities.length} activity entries`);
            }
        } catch (err) {
            console.error('Error loading activity database:', err);
            this.activities = [];
        }
    }

    save() {
        try {
            const data = {
                activities: this.activities.slice(0, 1000), // Keep only latest 1000 entries
                lastSaved: new Date().toISOString()
            };
            
            const tempFile = activityDbFile + '.tmp';
            fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
            
            if (fs.existsSync(activityDbFile)) {
                fs.copyFileSync(activityDbFile, activityDbFile + '.backup');
            }
            
            fs.renameSync(tempFile, activityDbFile);
        } catch (err) {
            console.error('Error saving activity database:', err);
        }
    }

    logActivity(type, message, metadata = {}) {
        const activity = {
            id: crypto.randomUUID(),
            type, // 'upload', 'like', 'report', 'moderation', 'flag'
            message,
            metadata,
            timestamp: new Date().toISOString()
        };
        
        this.activities.unshift(activity);
        
        // Keep only latest 1000 activities
        if (this.activities.length > 1000) {
            this.activities = this.activities.slice(0, 1000);
        }
        
        this.save();
        return activity;
    }

    getActivities(limit = 50) {
        return this.activities.slice(0, limit);
    }

    getActivitiesByType(type, limit = 50) {
        return this.activities.filter(a => a.type === type).slice(0, limit);
    }
}

class AutoFlaggingDatabase {
    constructor() {
        this.flaggedProfiles = [];
        this.flaggedKeywords = [
            // Racism
            'white power', 'racial purity', 'master race', 'white supremacy',
            // Transphobia  
            'tr*nny', 'tr@nny', 'tranny', 'tr4nny', '41%', 'attack helicopter',
            'real women', 'biological women', 'men in dresses',
            // Homophobia
            'f*ggot', 'f@ggot', 'faggot', 'f4ggot',
            // General hate
            'kill yourself', 'kys', 'rope yourself', 'gas the',
            // Slurs (partial list)
            'n*gger', 'n@gger', 'nigger', 'n1gger'
        ];
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(flaggedDbFile)) {
                const data = JSON.parse(fs.readFileSync(flaggedDbFile, 'utf-8'));
                this.flaggedProfiles = data.flaggedProfiles || [];
                this.flaggedKeywords = data.flaggedKeywords || this.flaggedKeywords;
                console.log(`🚩 Loaded ${this.flaggedProfiles.length} flagged profiles`);
            }
        } catch (err) {
            console.error('Error loading flagging database:', err);
            this.flaggedProfiles = [];
        }
    }

    save() {
        try {
            const data = {
                flaggedProfiles: this.flaggedProfiles,
                flaggedKeywords: this.flaggedKeywords,
                lastSaved: new Date().toISOString()
            };
            
            const tempFile = flaggedDbFile + '.tmp';
            fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
            
            if (fs.existsSync(flaggedDbFile)) {
                fs.copyFileSync(flaggedDbFile, flaggedDbFile + '.backup');
            }
            
            fs.renameSync(tempFile, flaggedDbFile);
        } catch (err) {
            console.error('Error saving flagging database:', err);
        }
    }

    scanProfile(characterId, characterName, bio, galleryStatus, tags) {
        const content = `${bio || ''} ${galleryStatus || ''} ${tags || ''}`.toLowerCase();
        const flaggedKeywords = [];
        
        for (const keyword of this.flaggedKeywords) {
            if (content.includes(keyword.toLowerCase())) {
                flaggedKeywords.push(keyword);
            }
        }
        
        if (flaggedKeywords.length > 0) {
            const flag = {
                id: crypto.randomUUID(),
                characterId,
                characterName,
                content: content.substring(0, 500), // Store first 500 chars for review
                flaggedKeywords,
                status: 'pending',
                flaggedAt: new Date().toISOString(),
                reviewedAt: null,
                reviewedBy: null
            };
            
            this.flaggedProfiles.unshift(flag);
            this.save();
            
            console.log(`🚩 Auto-flagged profile: ${characterName} for keywords: ${flaggedKeywords.join(', ')}`);
            
            // Log to activity feed
            activityDB.logActivity('flag', `AUTO-FLAGGED: ${characterName}`, {
                characterId,
                characterName,
                keywords: flaggedKeywords
            });
            
            return flag;
        }
        
        return null;
    }

    getFlaggedProfiles(status = null) {
        if (status) {
            return this.flaggedProfiles.filter(f => f.status === status);
        }
        return this.flaggedProfiles;
    }

    updateFlagStatus(flagId, status, reviewedBy) {
        const flag = this.flaggedProfiles.find(f => f.id === flagId);
        if (flag) {
            flag.status = status;
            flag.reviewedAt = new Date().toISOString();
            flag.reviewedBy = reviewedBy;
            this.save();
            
            // Log to activity feed
            activityDB.logActivity('moderation', `FLAG ${status.toUpperCase()}: ${flag.characterName}`, {
                flagId,
                characterName: flag.characterName,
                reviewedBy
            });
            
            return true;
        }
        return false;
    }

    addKeyword(keyword) {
        if (!this.flaggedKeywords.includes(keyword.toLowerCase())) {
            this.flaggedKeywords.push(keyword.toLowerCase());
            this.save();
            return true;
        }
        return false;
    }

    removeKeyword(keyword) {
        const index = this.flaggedKeywords.indexOf(keyword.toLowerCase());
        if (index !== -1) {
            this.flaggedKeywords.splice(index, 1);
            this.save();
            return true;
        }
        return false;
    }
}

// Initialize databases
const likesDB = new LikesDatabase();
const friendsDB = new FriendsDatabase();
const announcementsDB = new AnnouncementsDatabase();
const reportsDB = new ReportsDatabase();
const moderationDB = new ModerationDatabase();
const activityDB = new ActivityDatabase();
const autoFlagDB = new AutoFlaggingDatabase();

// Admin authentication middleware
function requireAdmin(req, res, next) {
    const adminKey = req.headers['x-admin-key'] || req.query.adminKey;
    if (adminKey !== process.env.ADMIN_SECRET_KEY) {
        return res.status(403).json({ error: 'Admin access required' });
    }
    
    // Get admin ID from header, fallback to 'unknown'
    req.adminId = req.headers['x-admin-id'] || req.body.adminId || 'unknown_admin';
    // Not logging every auth to avoid log spam - admin actions are logged separately
    next();
}

// Helper functions (keeping all the existing ones)

// Safe file move function that handles cross-device moves
async function safeFileMove(sourcePath, destPath) {
    try {
        // Try rename first (fastest)
        await new Promise((resolve, reject) => {
            fs.rename(sourcePath, destPath, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    } catch (err) {
        if (err.code === 'EXDEV') {
            // Cross-device link error, fall back to copy + delete
            console.log('Cross-device move detected, using copy + delete');
            await new Promise((resolve, reject) => {
                fs.copyFile(sourcePath, destPath, (copyErr) => {
                    if (copyErr) {
                        reject(copyErr);
                        return;
                    }
                    fs.unlink(sourcePath, (unlinkErr) => {
                        if (unlinkErr) console.warn('Failed to delete temp file:', unlinkErr);
                        resolve();
                    });
                });
            });
        } else {
            throw err;
        }
    }
}

async function cleanupOldCharacterVersions(csCharacterName, physicalCharacterName, newFileName) {
    try {
        const allFiles = await new Promise((resolve, reject) => {
            fs.readdir(profilesDir, (err, files) => {
                if (err) reject(err);
                else resolve(files.filter(file => 
                    file.endsWith('.json') && 
                    !file.endsWith('_follows.json') &&
                    file !== `${newFileName}.json`
                ));
            });
        });

        const oldVersions = [];
        
        for (const file of allFiles) {
            if (file.endsWith(`_${physicalCharacterName}.json`)) {
                try {
                    const filePath = path.join(profilesDir, file);
                    const oldProfile = await readProfileAsync(filePath);
                    
                    if (oldProfile.CharacterName === csCharacterName) {
                        oldVersions.push({ file, path: filePath });
                    }
                } catch (err) {
                    continue;
                }
            }
        }

        for (const oldVersion of oldVersions) {
            fs.unlinkSync(oldVersion.path);
        }
        
        if (oldVersions.length > 0) {
            galleryCache = null;
            allProfilesCache = null;
        }
    } catch (cleanupErr) {
        console.error('Error during cleanup:', cleanupErr.message);
    }
}

async function atomicWriteProfile(filePath, profile) {
    const tempPath = filePath + '.tmp';
    const backupPath = filePath + '.backup';
    
    try {
        // Create backup if original exists
        if (fs.existsSync(filePath)) {
            fs.copyFileSync(filePath, backupPath);
        }
        
        // Write directly using synchronous method to avoid temp file conflicts
        const jsonString = JSON.stringify(profile, null, 2);
        fs.writeFileSync(tempPath, jsonString, 'utf-8');
        
        // Atomic rename
        fs.renameSync(tempPath, filePath);
        
    } catch (error) {
        // Clean up temp file if it exists
        if (fs.existsSync(tempPath)) {
            try {
                fs.unlinkSync(tempPath);
            } catch (cleanupErr) {
                console.warn('Failed to cleanup temp file:', cleanupErr);
            }
        }
        throw error;
    }
}

function sanitizeGalleryData(profiles) {
    return profiles.map(profile => ({
        CharacterId: generateSafeId(profile.CharacterName, profile.CharacterId),
        CharacterName: profile.CharacterName,
        Server: "Gallery",
        ProfileImageUrl: null,
        Tags: profile.Tags,
        Bio: profile.Bio,
        GalleryStatus: profile.GalleryStatus,
        Race: profile.Race,
        Pronouns: profile.Pronouns,
        Links: profile.Links,
        LikeCount: profile.LikeCount,
        LastUpdated: profile.LastUpdated,
        ImageZoom: profile.ImageZoom,
        ImageOffset: profile.ImageOffset,
        IsNSFW: profile.IsNSFW || false // Include NSFW flag for client filtering
    }));
}

function sanitizeProfileResponse(profile) {
    const sanitized = { ...profile };
    delete sanitized.CustomImagePath;
    return sanitized;
}

function generateSafeId(characterName, originalId) {
    return characterName.toLowerCase().replace(/\s+/g, '_') + '_' + 
           crypto.createHash('md5').update(originalId).digest('hex').substring(0, 8);
}

const readProfileAsync = (filePath) => {
    return new Promise((resolve, reject) => {
        fs.readFile(filePath, 'utf-8', (err, data) => {
            if (err) {
                reject(err);
                return;
            }
            
            if (!data || data.trim().length === 0) {
                reject(new Error(`Profile file is empty: ${filePath}`));
                return;
            }
            
            try {
                const parsed = JSON.parse(data);
                resolve(parsed);
            } catch (parseError) {
                console.error(`[Error] Invalid JSON in file ${filePath}:`, parseError.message);
                fs.unlink(filePath, (unlinkErr) => {
                    if (!unlinkErr) {
                        console.log(`[Recovery] Deleted corrupted file: ${filePath}`);
                    }
                });
                reject(new Error(`Invalid JSON in profile file: ${filePath}`));
            }
        });
    });
};

const writeProfileAsync = (filePath, data) => {
    return new Promise((resolve, reject) => {
        let jsonString;
        try {
            jsonString = JSON.stringify(data, null, 2);
        } catch (stringifyError) {
            reject(stringifyError);
            return;
        }
        
        if (filePath.includes(' ')) {
            fs.writeFile(filePath, jsonString, 'utf-8', (writeErr) => {
                if (writeErr) reject(writeErr);
                else resolve();
            });
            return;
        }
        
        const tempPath = filePath + '.tmp';
        
        fs.writeFile(tempPath, jsonString, 'utf-8', (writeErr) => {
            if (writeErr) {
                reject(writeErr);
                return;
            }
            
            fs.rename(tempPath, filePath, (renameErr) => {
                if (renameErr) {
                    fs.unlink(tempPath, () => {});
                    reject(renameErr);
                    return;
                }
                resolve();
            });
        });
    });
};

const isValidProfile = (profile) => {
    return profile && 
           typeof profile === 'object' && 
           typeof profile.CharacterName === 'string' &&
           profile.CharacterName.length > 0;
};

function extractServerFromName(characterName) {
    const parts = characterName.split('@');
    return parts.length > 1 ? parts[1] : 'Unknown';
}

// =============================================================================
// 🖥️ ADMIN DASHBOARD - Served from admin-panel.html
// =============================================================================

// Cache the admin panel HTML at startup for performance
let adminPanelHtml = null;
try {
    adminPanelHtml = fs.readFileSync(path.join(__dirname, 'admin-panel.html'), 'utf8');
    console.log('✅ Admin panel loaded from admin-panel.html');
} catch (err) {
    console.error('⚠️ Could not load admin-panel.html:', err.message);
}

app.get("/admin", (req, res) => {
    if (adminPanelHtml) {
        res.send(adminPanelHtml);
    } else {
        res.status(500).send('Admin panel not available. Please ensure admin-panel.html exists.');
    }
});

// LEGACY EMBEDDED HTML REMOVED - Now served from admin-panel.html
// Original HTML started here:
// <!DOCTYPE html>
// <html lang="en">
// <head>
//     <meta charset="UTF-8">
// ... (3000+ lines of embedded HTML removed)
// Old route handler also removed - new handler above reads from file
// =============================================================================
// ALL YOUR EXISTING ENDPOINTS (keeping them exactly the same)
// =============================================================================

// Health check
app.get("/health", (req, res) => {
    res.status(200).json({ 
        status: "healthy", 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Upload endpoints (keeping all existing logic)
app.post("/upload/:name", upload.single("image"), async (req, res) => {
    try {
        const physicalCharacterName = decodeURIComponent(req.params.name);
        const profileJson = req.body.profile;

        if (!profileJson) {
            return res.status(400).send("Missing profile data.");
        }

        let profile;
        try {
            profile = JSON.parse(profileJson);
        } catch (err) {
            return res.status(400).send("Invalid profile JSON.");
        }

        const csCharacterName = profile.CharacterName;
        if (!csCharacterName) {
            return res.status(400).send("Missing CharacterName in profile data.");
        }

        const sanitizedCSName = csCharacterName.replace(/[^\w\s\-.']/g, "_");
        const newFileName = `${sanitizedCSName}_${physicalCharacterName}`;
        const characterId = newFileName;
        const filePath = path.join(profilesDir, `${newFileName}.json`);

        // Check if user is banned (blocks ALL uploads from this physical character)
        if (moderationDB.isUserBanned(physicalCharacterName)) {
            return res.status(403).json({ error: 'User has been banned from uploading profiles' });
        }

        if (moderationDB.isProfileBanned(characterId)) {
            return res.status(403).json({ error: 'Profile has been banned from the gallery' });
        }

        await cleanupOldCharacterVersions(csCharacterName, physicalCharacterName, newFileName);

        delete profile.LikeCount;
        profile.LikeCount = likesDB.getLikeCount(characterId);

        // Check if this is a truly new profile (file doesn't exist on server)
        const isNewProfile = !fs.existsSync(filePath);

        if (req.file) {
            const ext = path.extname(req.file.originalname) || ".png";
            const safeFileName = newFileName.replace(/[^\w@\-_.]/g, "_") + ext;
            const finalImagePath = path.join(imagesDir, safeFileName);

            await safeFileMove(req.file.path, finalImagePath);

            profile.ProfileImageUrl = `https://character-select-profile-server-production.up.railway.app/images/${safeFileName}`;
        }

        // Set CreatedAt only for truly new profiles (not updates to existing ones)
        if (isNewProfile) {
            profile.CreatedAt = new Date().toISOString();
        }
        profile.LastUpdated = new Date().toISOString();
        profile.LastActiveTime = new Date().toISOString();

        await atomicWriteProfile(filePath, profile);
        // Don't invalidate galleryCache here - let it refresh on 30-min schedule to avoid constant rebuilds
        // Incrementally update caches instead of full invalidation (scales better with 20k+ profiles)
        updateNamesCacheEntry(physicalCharacterName, csCharacterName, profile.NameplateColor, profile.Sharing, profile.AllowOthersToSeeMyCSName);
        updateProfilesLookupCacheEntry(physicalCharacterName, profile.Sharing);

        // Auto-flag check for problematic content
        autoFlagDB.scanProfile(characterId, csCharacterName, profile.Bio, profile.GalleryStatus, profile.Tags);

        // Log activity
        activityDB.logActivity('upload', `NEW PROFILE: ${csCharacterName}`, {
            characterId,
            characterName: csCharacterName,
            server: extractServerFromName(physicalCharacterName),
            hasImage: !!req.file
        });

        console.log(`✅ Saved profile: ${newFileName}.json (likes: ${profile.LikeCount})`);
        res.json(profile);
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put("/upload/:name", upload.single("image"), async (req, res) => {
    try {
        const physicalCharacterName = decodeURIComponent(req.params.name);
        const profileJson = req.body.profile;

        if (!profileJson) {
            return res.status(400).send("Missing profile data.");
        }

        let profile;
        try {
            profile = JSON.parse(profileJson);
        } catch (err) {
            return res.status(400).send("Invalid profile JSON.");
        }

        const csCharacterName = profile.CharacterName;
        if (!csCharacterName) {
            return res.status(400).send("Missing CharacterName in profile data.");
        }

        const sanitizedCSName = csCharacterName.replace(/[^\w\s\-.']/g, "_");
        const newFileName = `${sanitizedCSName}_${physicalCharacterName}`;
        const characterId = newFileName;
        const filePath = path.join(profilesDir, `${newFileName}.json`);

        // Check if user is banned (blocks ALL uploads from this physical character)
        if (moderationDB.isUserBanned(physicalCharacterName)) {
            return res.status(403).json({ error: 'User has been banned from uploading profiles' });
        }

        if (moderationDB.isProfileBanned(characterId)) {
            return res.status(403).json({ error: 'Profile has been banned from the gallery' });
        }

        await cleanupOldCharacterVersions(csCharacterName, physicalCharacterName, newFileName);

        delete profile.LikeCount;
        profile.LikeCount = likesDB.getLikeCount(characterId);

        // Check if this is a truly new profile (file doesn't exist on server)
        const isNewProfile = !fs.existsSync(filePath);

        if (req.file) {
            const ext = path.extname(req.file.originalname) || ".png";
            const safeFileName = newFileName.replace(/[^\w@\-_.]/g, "_") + ext;
            const finalImagePath = path.join(imagesDir, safeFileName);

            await safeFileMove(req.file.path, finalImagePath);

            profile.ProfileImageUrl = `https://character-select-profile-server-production.up.railway.app/images/${safeFileName}`;
        }

        // Set CreatedAt only for truly new profiles (not updates to existing ones)
        if (isNewProfile) {
            profile.CreatedAt = new Date().toISOString();
        }
        profile.LastUpdated = new Date().toISOString();
        profile.LastActiveTime = new Date().toISOString();

        await atomicWriteProfile(filePath, profile);
        // Don't invalidate galleryCache here - let it refresh on 30-min schedule to avoid constant rebuilds
        // Incrementally update caches instead of full invalidation (scales better with 20k+ profiles)
        updateNamesCacheEntry(physicalCharacterName, csCharacterName, profile.NameplateColor, profile.Sharing, profile.AllowOthersToSeeMyCSName);
        updateProfilesLookupCacheEntry(physicalCharacterName, profile.Sharing);

        // Auto-flag check for problematic content
        autoFlagDB.scanProfile(characterId, csCharacterName, profile.Bio, profile.GalleryStatus, profile.Tags);

        // Log activity
        activityDB.logActivity('upload', isNewProfile ? `NEW PROFILE: ${csCharacterName}` : `UPDATED PROFILE: ${csCharacterName}`, {
            characterId,
            characterName: csCharacterName,
            server: extractServerFromName(physicalCharacterName),
            hasImage: !!req.file
        });

        console.log(`✅ PUT updated profile: ${newFileName}.json (likes: ${profile.LikeCount})`);
        res.json(profile);
    } catch (error) {
        console.error('PUT error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// View endpoint
app.get("/view/:name", async (req, res) => {
    try {
        const requestedName = decodeURIComponent(req.params.name);
        let filePath = path.join(profilesDir, `${requestedName}.json`);
        
        if (fs.existsSync(filePath)) {
            try {
                const profile = await readProfileAsync(filePath);
                const sanitizedProfile = sanitizeProfileResponse(profile);
                return res.json(sanitizedProfile);
            } catch (err) {
                console.error(`Error reading profile ${requestedName}:`, err.message);
            }
        }

        const profileFiles = await new Promise((resolve, reject) => {
            fs.readdir(profilesDir, (err, files) => {
                if (err) reject(err);
                else resolve(files.filter(file => 
                    file.endsWith('.json') && 
                    !file.endsWith('_follows.json')
                ));
            });
        });

        const matchingProfiles = [];
        const expectedSuffix = `_${requestedName}.json`;

        for (let i = 0; i < profileFiles.length; i += 5) {
            const batch = profileFiles.slice(i, i + 5);
            
            await Promise.all(batch.map(async (file) => {
                if (file.endsWith(expectedSuffix)) {
                    const fullPath = path.join(profilesDir, file);
                    try {
                        const stats = await new Promise((resolve, reject) => {
                            fs.stat(fullPath, (err, stats) => {
                                if (err) reject(err);
                                else resolve(stats);
                            });
                        });
                        const profileData = await readProfileAsync(fullPath);
                        
                        if (isValidProfile(profileData)) {
                            matchingProfiles.push({
                                file: file,
                                lastModified: stats.mtime,
                                profile: profileData
                            });
                        }
                    } catch (err) {
                        console.error(`Error processing ${file}:`, err.message);
                    }
                }
            }));
        }

        if (matchingProfiles.length === 0) {
            return res.status(404).json({ error: "Profile not found" });
        }

        matchingProfiles.sort((a, b) => b.lastModified - a.lastModified);
        
        const sanitizedProfile = sanitizeProfileResponse(matchingProfiles[0].profile);
        res.json(sanitizedProfile);
    } catch (err) {
        console.error(`Error in view endpoint: ${err}`);
        res.status(500).json({ error: "Server error" });
    }
});

// ===============================
// 🔍 NAMES LOOKUP ENDPOINT
// ===============================
// Batch lookup CS+ names for multiple physical character names
// Used for shared name replacement feature
// Now with caching for performance under load

// Unified startup cache warmer - reads all profile files ONCE and populates all 4 caches
// This avoids reading 24k+ files 4 separate times at startup
async function warmAllCaches() {
    const startTime = Date.now();
    console.log(`🔄 Warming all caches (single pass)...`);

    try {
        // Read directory once
        const profileFiles = await new Promise((resolve, reject) => {
            fs.readdir(profilesDir, (err, files) => {
                if (err) reject(err);
                else resolve(files.filter(file =>
                    file.endsWith('.json') &&
                    !file.endsWith('_follows.json')
                ));
            });
        });

        console.log(`📁 Found ${profileFiles.length} profile files`);

        // Data collectors for all 4 caches
        const namesResults = [];          // For names cache
        const profilesLookupResults = []; // For profiles lookup cache
        const galleryResults = [];        // For gallery cache
        const allProfileResults = [];     // For all profiles cache

        const BATCH_SIZE = 25;
        for (let i = 0; i < profileFiles.length; i += BATCH_SIZE) {
            const batch = profileFiles.slice(i, i + BATCH_SIZE);

            const batchResults = await Promise.all(batch.map(async (file) => {
                try {
                    const characterId = file.replace('.json', '');
                    const fullPath = path.join(profilesDir, file);

                    // Extract physical name from filename
                    const lastUnderscore = characterId.lastIndexOf('_');
                    if (lastUnderscore === -1) return null;
                    const physicalName = characterId.substring(lastUnderscore + 1);
                    if (!physicalName || !physicalName.includes('@')) return null;

                    // Read file once
                    const fileContent = await fs.promises.readFile(fullPath, 'utf-8');
                    if (!fileContent || fileContent.trim().length === 0) return null;
                    const profileData = JSON.parse(fileContent);
                    if (!isValidProfile(profileData)) return null;

                    // Get timing info
                    let activeTime;
                    if (profileData.LastActiveTime) {
                        activeTime = new Date(profileData.LastActiveTime).getTime();
                    } else {
                        const stats = await fs.promises.stat(fullPath);
                        activeTime = stats.mtime.getTime();
                    }

                    return { file, characterId, physicalName, fullPath, profileData, activeTime };
                } catch (err) {
                    return null;
                }
            }));

            for (const result of batchResults) {
                if (result) {
                    namesResults.push(result);
                    profilesLookupResults.push(result);
                    galleryResults.push(result);
                    allProfileResults.push(result);
                }
            }

            // Yield to event loop
            if (i % 250 === 0 && i > 0) {
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        }

        console.log(`📖 Read ${namesResults.length} valid profiles in ${Date.now() - startTime}ms`);

        // === Build Names Cache ===
        const newNamesCache = new Map();
        const newestActiveTime = new Map();
        const tempNamesIndex = new Map();
        const expiryTime = Date.now() - (NAME_SYNC_EXPIRY_HOURS * 60 * 60 * 1000);

        for (const { physicalName, activeTime, profileData } of namesResults) {
            const seenNewerTime = newestActiveTime.get(physicalName);
            if (seenNewerTime && seenNewerTime > activeTime) continue;
            newestActiveTime.set(physicalName, activeTime);
            tempNamesIndex.delete(physicalName);

            if (profileData.Sharing === 'NeverShare' || profileData.Sharing === 1) continue;
            if (profileData.AllowOthersToSeeMyCSName !== true) continue;
            if (activeTime < expiryTime) continue;
            if (moderationDB.isNameBanned(physicalName)) continue;
            if (!profileData.CharacterName) continue;

            let colorArray = [1.0, 1.0, 1.0];
            if (profileData.NameplateColor) {
                if (Array.isArray(profileData.NameplateColor)) {
                    colorArray = profileData.NameplateColor;
                } else if (typeof profileData.NameplateColor === 'object') {
                    colorArray = [
                        profileData.NameplateColor.X ?? 1.0,
                        profileData.NameplateColor.Y ?? 1.0,
                        profileData.NameplateColor.Z ?? 1.0
                    ];
                }
            }
            tempNamesIndex.set(physicalName, { csName: profileData.CharacterName, nameplateColor: colorArray });
        }
        for (const [k, v] of tempNamesIndex) newNamesCache.set(k, v);
        namesCache = newNamesCache;
        namesCacheTime = Date.now();
        console.log(`✅ Names cache: ${newNamesCache.size} entries`);

        // === Build Profiles Lookup Cache ===
        const newProfilesLookupCache = new Set();
        const newestModTime = new Map();
        const tempProfilesIndex = new Map();

        for (const { file, physicalName, activeTime, profileData } of profilesLookupResults) {
            const seenNewerTime = newestModTime.get(physicalName);
            if (seenNewerTime && seenNewerTime > activeTime) continue;
            newestModTime.set(physicalName, activeTime);
            tempProfilesIndex.delete(physicalName);

            if (profileData.Sharing === 'NeverShare' || profileData.Sharing === 1) continue;
            if (moderationDB.isProfileBanned(file.replace('.json', ''))) continue;
            tempProfilesIndex.set(physicalName, activeTime);
        }
        for (const k of tempProfilesIndex.keys()) newProfilesLookupCache.add(k);
        profilesLookupCache = newProfilesLookupCache;
        profilesLookupCacheTime = Date.now();
        console.log(`✅ Profiles lookup cache: ${newProfilesLookupCache.size} entries`);

        // === Build Gallery Cache ===
        const showcaseProfiles = [];
        for (const { characterId, physicalName, profileData } of galleryResults) {
            if (moderationDB.isProfileBanned(characterId)) continue;
            if (profileData.Sharing !== 'ShowcasePublic' && profileData.Sharing !== 2) continue;

            const underscoreIndex = characterId.indexOf('_');
            let csCharacterName;
            if (underscoreIndex > 0) {
                csCharacterName = characterId.substring(0, underscoreIndex);
            } else {
                csCharacterName = profileData.CharacterName || characterId.split('@')[0];
            }

            showcaseProfiles.push({
                CharacterId: characterId,
                CharacterName: csCharacterName,
                Server: extractServerFromName(physicalName),
                ProfileImageUrl: profileData.ProfileImageUrl || null,
                Tags: profileData.Tags || "",
                Bio: profileData.Bio || "",
                GalleryStatus: profileData.GalleryStatus || "",
                Race: profileData.Race || "",
                Pronouns: profileData.Pronouns || "",
                Links: profileData.Links || "",
                LikeCount: likesDB.getLikeCount(characterId),
                LastUpdated: profileData.LastUpdated || new Date().toISOString(),
                ImageZoom: profileData.ImageZoom || 1.0,
                ImageOffset: profileData.ImageOffset || { X: 0, Y: 0 },
                IsNSFW: profileData.IsNSFW || false
            });
        }
        showcaseProfiles.sort((a, b) => b.LikeCount - a.LikeCount);
        galleryCache = showcaseProfiles;
        galleryCacheTime = Date.now();
        console.log(`✅ Gallery cache: ${showcaseProfiles.length} profiles`);

        // === Build All Profiles Cache ===
        const allProfiles = [];
        for (const { characterId, physicalName, profileData } of allProfileResults) {
            const sharing = profileData.Sharing;
            const isShowcasePublic = sharing === 'ShowcasePublic' || sharing === 2;
            const isAlwaysShare = sharing === 'AlwaysShare' || sharing === 0;
            if (!isShowcasePublic && !isAlwaysShare) continue;

            const underscoreIndex = characterId.indexOf('_');
            let csCharacterName;
            if (underscoreIndex > 0) {
                csCharacterName = characterId.substring(0, underscoreIndex);
            } else {
                csCharacterName = profileData.CharacterName || characterId.split('@')[0];
            }

            allProfiles.push({
                CharacterId: characterId,
                CharacterName: csCharacterName,
                Server: extractServerFromName(physicalName),
                ProfileImageUrl: profileData.ProfileImageUrl || null,
                Tags: profileData.Tags || "",
                Bio: profileData.Bio || "",
                GalleryStatus: profileData.GalleryStatus || "",
                Race: profileData.Race || "",
                Pronouns: profileData.Pronouns || "",
                Links: profileData.Links || "",
                LikeCount: likesDB.getLikeCount(characterId),
                LastUpdated: profileData.LastUpdated || new Date().toISOString(),
                ImageZoom: profileData.ImageZoom || 1.0,
                ImageOffset: profileData.ImageOffset || { X: 0, Y: 0 },
                IsNSFW: profileData.IsNSFW || false,
                Sharing: isShowcasePublic ? 'ShowcasePublic' : 'AlwaysShare',
                IsBanned: moderationDB.isProfileBanned(characterId)
            });
        }
        allProfiles.sort((a, b) => new Date(b.LastUpdated) - new Date(a.LastUpdated));
        allProfilesCache = allProfiles;
        allProfilesCacheTime = Date.now();
        console.log(`✅ All profiles cache: ${allProfiles.length} profiles`);

        const elapsed = Date.now() - startTime;
        console.log(`🔄 All caches ready in ${elapsed}ms (single pass over ${namesResults.length} files)`);
    } catch (err) {
        console.error(`⚠️ Cache warm failed: ${err}`);
    }
}

// Build/rebuild the names cache (non-blocking - serves stale while rebuilding)
async function rebuildNamesCache(waitForCompletion = false) {
    if (namesCacheBuilding) {
        // If caller needs to wait for cache, poll until ready
        if (waitForCompletion) {
            while (namesCacheBuilding) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
        return;
    }

    namesCacheBuilding = true;
    const startTime = Date.now();

    try {
        const newCache = new Map();

        // Get all profile files
        const profileFiles = await new Promise((resolve, reject) => {
            fs.readdir(profilesDir, (err, files) => {
                if (err) reject(err);
                else resolve(files.filter(file =>
                    file.endsWith('.json') &&
                    !file.endsWith('_follows.json')
                ));
            });
        });

        // Build index: physicalName -> {csName, nameplateColor, activeTime}
        // We use LastActiveTime from profile data (set on every upload) instead of file modTime
        // This ensures the most recently APPLIED character is used, not just most recently modified file
        const allResults = []; // Collect all valid results first

        // Process files in smaller batches with delays to prevent server overload
        const BATCH_SIZE = 25; // Reduced from 100 to prevent resource exhaustion
        for (let i = 0; i < profileFiles.length; i += BATCH_SIZE) {
            const batch = profileFiles.slice(i, i + BATCH_SIZE);

            // Process batch in parallel
            const batchResults = await Promise.all(batch.map(async (file) => {
                try {
                    // Extract physical name from filename: "CSName_PhysicalName@World.json"
                    const lastUnderscore = file.lastIndexOf('_');
                    if (lastUnderscore === -1) return null;

                    const physicalName = file.substring(lastUnderscore + 1, file.length - 5); // Remove .json
                    if (!physicalName || !physicalName.includes('@')) return null;

                    const fullPath = path.join(profilesDir, file);

                    // Read profile to get LastActiveTime
                    const fileContent = await fs.promises.readFile(fullPath, 'utf-8');
                    const profileData = JSON.parse(fileContent);

                    // Use LastActiveTime from profile, fallback to file modTime if not present
                    let activeTime;
                    if (profileData.LastActiveTime) {
                        activeTime = new Date(profileData.LastActiveTime).getTime();
                    } else {
                        const stats = await fs.promises.stat(fullPath);
                        activeTime = stats.mtime.getTime();
                    }

                    return {
                        physicalName,
                        activeTime,
                        profileData
                    };
                } catch (err) {
                    return null; // Skip files that can't be read
                }
            }));

            // Collect non-null results
            for (const result of batchResults) {
                if (result) allResults.push(result);
            }

            // Yield to event loop between batches with small delay to let other requests through
            await new Promise(resolve => setTimeout(resolve, 10));
        }

        // Now process all results to find newest per physical name
        const newestActiveTime = new Map();
        const tempIndex = new Map();

        for (const { physicalName, activeTime, profileData } of allResults) {
            // Check if we've already seen a newer file for this physical name
            const seenNewerTime = newestActiveTime.get(physicalName);
            if (seenNewerTime && seenNewerTime > activeTime) continue; // Skip older profiles

            // Track this as the newest activeTime we've seen
            newestActiveTime.set(physicalName, activeTime);

            // Clear any older entry - if this newer profile fails validation, we want NO entry
            tempIndex.delete(physicalName);

            // Skip if NeverShare (NeverShare = 1 in the enum)
            if (profileData.Sharing === 'NeverShare' || profileData.Sharing === 1) continue;

            // Skip if user hasn't opted in to name visibility
            if (profileData.AllowOthersToSeeMyCSName !== true) continue;

            // Skip if profile is older than 24 hours (Name Sync expiry - profiles NOT deleted, just excluded from Name Sync)
            const expiryTime = Date.now() - (NAME_SYNC_EXPIRY_HOURS * 60 * 60 * 1000);
            if (activeTime < expiryTime) continue;

            // Skip if name banned
            if (moderationDB.isNameBanned(physicalName)) continue;

            // Skip if no character name
            if (!profileData.CharacterName) continue;

            // Convert nameplate colour
            let colorArray = [1.0, 1.0, 1.0];
            if (profileData.NameplateColor) {
                if (Array.isArray(profileData.NameplateColor)) {
                    colorArray = profileData.NameplateColor;
                } else if (typeof profileData.NameplateColor === 'object') {
                    colorArray = [
                        profileData.NameplateColor.X ?? 1.0,
                        profileData.NameplateColor.Y ?? 1.0,
                        profileData.NameplateColor.Z ?? 1.0
                    ];
                }
            }

            tempIndex.set(physicalName, {
                csName: profileData.CharacterName,
                nameplateColor: colorArray
            });
        }

        // Copy to final cache
        for (const [physicalName, data] of tempIndex) {
            newCache.set(physicalName, data);
        }

        namesCache = newCache;
        namesCacheTime = Date.now();

        const elapsed = Date.now() - startTime;
        console.log(`🔍 Names cache rebuilt: ${newCache.size} entries in ${elapsed}ms`);
    } catch (err) {
        console.error('Error rebuilding names cache:', err);
    } finally {
        namesCacheBuilding = false;
    }
}

// Invalidate names cache (call when profiles are uploaded/deleted)
function invalidateNamesCache() {
    namesCache = null;
    namesCacheTime = 0;
}

// Update a single entry in the names cache (avoids full rebuild)
function updateNamesCacheEntry(physicalName, csName, nameplateColor, sharing, allowOthersToSee) {
    if (!namesCache) return; // Cache not built yet, will be built on next request

    // Check if this profile should be visible in names lookup
    const isPrivate = sharing === 'NeverShare' || sharing === 1;
    const optedIn = allowOthersToSee === true;

    if (isPrivate || !optedIn) {
        // Remove from cache if exists
        namesCache.delete(physicalName);
    } else {
        // Add/update in cache
        let color = [1, 1, 1]; // Default white
        if (nameplateColor) {
            if (Array.isArray(nameplateColor)) {
                color = nameplateColor;
            } else if (typeof nameplateColor === 'object') {
                color = [nameplateColor.X || 1, nameplateColor.Y || 1, nameplateColor.Z || 1];
            }
        }
        namesCache.set(physicalName, { csName, nameplateColor: color });
    }
}

app.post("/names/lookup", async (req, res) => {
    try {
        const { characters } = req.body;

        if (!Array.isArray(characters) || characters.length === 0) {
            return res.status(400).json({ error: "Invalid request: characters array required" });
        }

        // Check if cache needs refresh
        const now = Date.now();
        const cacheStale = !namesCache || (now - namesCacheTime) > NAMES_CACHE_DURATION;

        if (cacheStale) {
            if (namesCache) {
                // Cache exists but stale - trigger background rebuild, serve stale data now
                rebuildNamesCache(); // Don't await - runs in background
            } else {
                // No cache at all - must wait for initial build
                await rebuildNamesCache(true);
            }
        }

        // Limit batch size to prevent abuse
        const limitedChars = characters.slice(0, 50);
        const results = {};

        // Fast lookup from cache (may be stale but that's ok)
        for (const physicalName of limitedChars) {
            if (!physicalName || typeof physicalName !== 'string') continue;

            const cached = namesCache?.get(physicalName);
            if (cached) {
                results[physicalName] = cached;
            }
        }

        res.json({ results });
    } catch (err) {
        console.error(`Error in names lookup endpoint: ${err}`);
        res.status(500).json({ error: "Server error" });
    }
});

// ===============================
// 📋 RP PROFILES LOOKUP (for context menu)
// ===============================
// Separate from names lookup - checks if users have shared RP profiles
// Does NOT require AllowOthersToSeeMyCSName - just checks if profile exists and is shared

async function rebuildProfilesLookupCache(waitForCompletion = false) {
    if (profilesLookupCacheBuilding) {
        // If caller needs to wait for cache, poll until ready
        if (waitForCompletion) {
            while (profilesLookupCacheBuilding) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
        return;
    }

    profilesLookupCacheBuilding = true;
    const startTime = Date.now();

    try {
        const newCache = new Set();

        const profileFiles = await new Promise((resolve, reject) => {
            fs.readdir(profilesDir, (err, files) => {
                if (err) reject(err);
                else resolve(files.filter(file =>
                    file.endsWith('.json') &&
                    !file.endsWith('_follows.json')
                ));
            });
        });

        // Collect all results first using parallel batch processing
        const allResults = [];
        const BATCH_SIZE = 25; // Reduced from 100 to prevent resource exhaustion

        for (let i = 0; i < profileFiles.length; i += BATCH_SIZE) {
            const batch = profileFiles.slice(i, i + BATCH_SIZE);

            const batchResults = await Promise.all(batch.map(async (file) => {
                try {
                    // Extract physical name from filename: "CSName_PhysicalName@World.json"
                    const lastUnderscore = file.lastIndexOf('_');
                    if (lastUnderscore === -1) return null;

                    const physicalName = file.substring(lastUnderscore + 1, file.length - 5);
                    if (!physicalName || !physicalName.includes('@')) return null;

                    const fullPath = path.join(profilesDir, file);
                    const stats = await fs.promises.stat(fullPath);
                    const modTime = stats.mtime.getTime();

                    // Read and validate profile
                    const fileContent = await fs.promises.readFile(fullPath, 'utf-8');
                    const profileData = JSON.parse(fileContent);

                    return { file, physicalName, modTime, profileData };
                } catch (err) {
                    return null;
                }
            }));

            for (const result of batchResults) {
                if (result) allResults.push(result);
            }

            // Yield to event loop between batches with small delay to let other requests through
            await new Promise(resolve => setTimeout(resolve, 10));
        }

        // Process results to find newest per physical name
        const tempIndex = new Map();
        const newestModTime = new Map();

        for (const { file, physicalName, modTime, profileData } of allResults) {
            // Check if we've already seen a newer file for this physical name
            const seenNewerTime = newestModTime.get(physicalName);
            if (seenNewerTime && seenNewerTime > modTime) continue;

            newestModTime.set(physicalName, modTime);
            tempIndex.delete(physicalName);

            // Skip if NeverShare
            if (profileData.Sharing === 'NeverShare' || profileData.Sharing === 1) continue;

            // Skip if banned
            if (moderationDB.isProfileBanned(file.replace('.json', ''))) continue;

            // Has a shared profile (AlwaysShare or ShowcasePublic)
            tempIndex.set(physicalName, modTime);
        }

        // Convert to Set
        for (const physicalName of tempIndex.keys()) {
            newCache.add(physicalName);
        }

        profilesLookupCache = newCache;
        profilesLookupCacheTime = Date.now();

        const elapsed = Date.now() - startTime;
        console.log(`📋 Profiles lookup cache rebuilt: ${newCache.size} entries in ${elapsed}ms`);
    } catch (err) {
        console.error('Error rebuilding profiles lookup cache:', err);
    } finally {
        profilesLookupCacheBuilding = false;
    }
}

function invalidateProfilesLookupCache() {
    profilesLookupCache = null;
    profilesLookupCacheTime = 0;
}

// Update a single entry in the profiles lookup cache (avoids full rebuild)
function updateProfilesLookupCacheEntry(physicalName, sharing) {
    if (!profilesLookupCache) return; // Cache not built yet, will be built on next request

    const isPrivate = sharing === 'NeverShare' || sharing === 1;

    if (isPrivate) {
        // Remove from cache if exists
        profilesLookupCache.delete(physicalName);
    } else {
        // Add to cache (AlwaysShare or ShowcasePublic)
        profilesLookupCache.add(physicalName);
    }
}

app.post("/profiles/lookup", async (req, res) => {
    try {
        const { characters } = req.body;

        if (!Array.isArray(characters) || characters.length === 0) {
            return res.status(400).json({ error: "Invalid request: characters array required" });
        }

        // Check if cache needs refresh
        const now = Date.now();
        const cacheStale = !profilesLookupCache || (now - profilesLookupCacheTime) > PROFILES_LOOKUP_CACHE_DURATION;

        if (cacheStale) {
            if (profilesLookupCache) {
                // Cache exists but stale - trigger background rebuild, serve stale data now
                rebuildProfilesLookupCache(); // Don't await - runs in background
            } else {
                // No cache at all - must wait for initial build
                await rebuildProfilesLookupCache(true);
            }
        }

        // Limit batch size to prevent abuse
        const limitedChars = characters.slice(0, 50);
        const results = {};

        // Fast lookup from cache (may be stale but that's ok)
        for (const physicalName of limitedChars) {
            if (!physicalName || typeof physicalName !== 'string') continue;

            if (profilesLookupCache?.has(physicalName)) {
                results[physicalName] = { hasProfile: true };
            }
        }

        res.json({ results });
    } catch (err) {
        console.error(`Error in profiles lookup endpoint: ${err}`);
        res.status(500).json({ error: "Server error" });
    }
});

// Gallery cache rebuild function (runs in background)
async function rebuildGalleryCache(waitForCompletion = false) {
    if (galleryCacheBuilding) {
        // If caller needs to wait for cache, poll until ready
        if (waitForCompletion) {
            while (galleryCacheBuilding) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
        return;
    }
    galleryCacheBuilding = true;

    const startTime = Date.now();
    try {
        const profileFiles = await new Promise((resolve, reject) => {
            fs.readdir(profilesDir, (err, files) => {
                if (err) reject(err);
                else resolve(files.filter(file =>
                    file.endsWith('.json') &&
                    !file.endsWith('_follows.json')
                ));
            });
        });

        const showcaseProfiles = [];

        for (let i = 0; i < profileFiles.length; i += 25) {
            const batch = profileFiles.slice(i, i + 25);

            const batchResults = await Promise.all(batch.map(async (file) => {
                const characterId = file.replace('.json', '');
                const filePath = path.join(profilesDir, file);

                try {
                    if (moderationDB.isProfileBanned(characterId)) {
                        return null;
                    }

                    const profileData = await readProfileAsync(filePath);

                    if (!isValidProfile(profileData)) {
                        return null;
                    }

                    if (profileData.Sharing === 'ShowcasePublic' || profileData.Sharing === 2) {
                        const underscoreIndex = characterId.indexOf('_');
                        let csCharacterName, physicalCharacterName;

                        if (underscoreIndex > 0) {
                            csCharacterName = characterId.substring(0, underscoreIndex);
                            physicalCharacterName = characterId.substring(underscoreIndex + 1);
                        } else {
                            csCharacterName = profileData.CharacterName || characterId.split('@')[0];
                            physicalCharacterName = characterId;
                        }

                        return {
                            CharacterId: characterId,
                            CharacterName: csCharacterName,
                            Server: extractServerFromName(physicalCharacterName),
                            ProfileImageUrl: profileData.ProfileImageUrl || null,
                            Tags: profileData.Tags || "",
                            Bio: profileData.Bio || "",
                            GalleryStatus: profileData.GalleryStatus || "",
                            Race: profileData.Race || "",
                            Pronouns: profileData.Pronouns || "",
                            Links: profileData.Links || "",
                            LikeCount: likesDB.getLikeCount(characterId),
                            LastUpdated: profileData.LastUpdated || new Date().toISOString(),
                            ImageZoom: profileData.ImageZoom || 1.0,
                            ImageOffset: profileData.ImageOffset || { X: 0, Y: 0 },
                            IsNSFW: profileData.IsNSFW || false
                        };
                    }
                    return null;
                } catch (err) {
                    return null;
                }
            }));

            batchResults.forEach(result => {
                if (result) showcaseProfiles.push(result);
            });

            // Yield to event loop between batches
            await new Promise(resolve => setTimeout(resolve, 10));
        }

        showcaseProfiles.sort((a, b) => b.LikeCount - a.LikeCount);

        galleryCache = showcaseProfiles;
        galleryCacheTime = Date.now();
        console.log(`📚 Gallery cache rebuilt: ${showcaseProfiles.length} profiles in ${Date.now() - startTime}ms`);
    } catch (err) {
        console.error(`Gallery cache rebuild error: ${err}`);
    } finally {
        galleryCacheBuilding = false;
    }
}

// All Profiles cache rebuild (admin endpoint, both ShowcasePublic + AlwaysShare)
async function rebuildAllProfilesCache(waitForCompletion = false) {
    if (allProfilesCacheBuilding) {
        if (waitForCompletion) {
            while (allProfilesCacheBuilding) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
        return;
    }
    allProfilesCacheBuilding = true;

    const startTime = Date.now();
    try {
        const profileFiles = await new Promise((resolve, reject) => {
            fs.readdir(profilesDir, (err, files) => {
                if (err) reject(err);
                else resolve(files.filter(file =>
                    file.endsWith('.json') &&
                    !file.endsWith('_follows.json')
                ));
            });
        });

        const allProfiles = [];

        for (let i = 0; i < profileFiles.length; i += 25) {
            const batch = profileFiles.slice(i, i + 25);

            const batchResults = await Promise.all(batch.map(async (file) => {
                const characterId = file.replace('.json', '');
                const filePath = path.join(profilesDir, file);

                try {
                    const profileData = await readProfileAsync(filePath);
                    if (!isValidProfile(profileData)) return null;

                    const sharing = profileData.Sharing;
                    const isShowcasePublic = sharing === 'ShowcasePublic' || sharing === 2;
                    const isAlwaysShare = sharing === 'AlwaysShare' || sharing === 0;
                    if (!isShowcasePublic && !isAlwaysShare) return null;

                    const underscoreIndex = characterId.indexOf('_');
                    let csCharacterName, physicalCharacterName;
                    if (underscoreIndex > 0) {
                        csCharacterName = characterId.substring(0, underscoreIndex);
                        physicalCharacterName = characterId.substring(underscoreIndex + 1);
                    } else {
                        csCharacterName = profileData.CharacterName || characterId.split('@')[0];
                        physicalCharacterName = characterId;
                    }

                    return {
                        CharacterId: characterId,
                        CharacterName: csCharacterName,
                        Server: extractServerFromName(physicalCharacterName),
                        ProfileImageUrl: profileData.ProfileImageUrl || null,
                        Tags: profileData.Tags || "",
                        Bio: profileData.Bio || "",
                        GalleryStatus: profileData.GalleryStatus || "",
                        Race: profileData.Race || "",
                        Pronouns: profileData.Pronouns || "",
                        Links: profileData.Links || "",
                        LikeCount: likesDB.getLikeCount(characterId),
                        LastUpdated: profileData.LastUpdated || new Date().toISOString(),
                        ImageZoom: profileData.ImageZoom || 1.0,
                        ImageOffset: profileData.ImageOffset || { X: 0, Y: 0 },
                        IsNSFW: profileData.IsNSFW || false,
                        Sharing: isShowcasePublic ? 'ShowcasePublic' : 'AlwaysShare',
                        IsBanned: moderationDB.isProfileBanned(characterId)
                    };
                } catch (err) {
                    return null;
                }
            }));

            batchResults.forEach(result => {
                if (result) allProfiles.push(result);
            });

            // Yield to event loop between batches
            await new Promise(resolve => setTimeout(resolve, 10));
        }

        allProfiles.sort((a, b) => new Date(b.LastUpdated) - new Date(a.LastUpdated));

        allProfilesCache = allProfiles;
        allProfilesCacheTime = Date.now();
        console.log(`📋 All profiles cache rebuilt: ${allProfiles.length} profiles in ${Date.now() - startTime}ms`);
    } catch (err) {
        console.error(`All profiles cache rebuild error: ${err}`);
    } finally {
        allProfilesCacheBuilding = false;
    }
}

function invalidateAllProfilesCache() {
    allProfilesCache = null;
    allProfilesCacheTime = 0;
}

// Gallery endpoint
app.get("/gallery", async (req, res) => {
    try {
        const isPlugin = req.headers['x-plugin-auth'] === 'cs-plus-gallery-client';
        const isAdmin = req.query.admin === 'true' && req.query.key === process.env.ADMIN_SECRET_KEY;
        const showNSFW = req.query.nsfw === 'true'; // Client can request NSFW content

        const now = Date.now();
        const cacheStale = !galleryCache || (now - galleryCacheTime) >= CACHE_DURATION;

        // Serve stale cache while rebuilding in background
        if (cacheStale) {
            if (galleryCache) {
                // Cache exists but stale - trigger background rebuild
                rebuildGalleryCache();
            } else {
                // No cache at all - must wait for initial build (with waitForCompletion flag)
                await rebuildGalleryCache(true);
            }
        }

        // Return from cache (may be stale but that's ok)
        let profiles = galleryCache || [];

        // Apply NSFW filter if requested
        if (!showNSFW && !isAdmin) {
            profiles = profiles.filter(profile => !profile.IsNSFW);
        }

        if (isPlugin || isAdmin) {
            return res.json(profiles);
        } else {
            return res.json(sanitizeGalleryData(profiles));
        }
    } catch (err) {
        console.error('Gallery error:', err);
        res.status(500).json({ error: 'Failed to load gallery' });
    }
});

// All Profiles endpoint (admin only) - cached like gallery
app.get("/profiles/all", async (req, res) => {
    try {
        const isAdmin = req.query.admin === 'true' && req.query.key === process.env.ADMIN_SECRET_KEY;

        if (!isAdmin) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const now = Date.now();
        const cacheStale = !allProfilesCache || (now - allProfilesCacheTime) >= CACHE_DURATION;

        if (cacheStale) {
            if (allProfilesCache) {
                rebuildAllProfilesCache();
            } else {
                await rebuildAllProfilesCache(true);
            }
        }

        res.json(allProfilesCache || []);

    } catch (err) {
        console.error('All profiles error:', err);
        res.status(500).json({ error: 'Failed to load profiles' });
    }
});

// Like endpoints
app.post("/gallery/:name/like", async (req, res) => {
    try {
        const characterId = decodeURIComponent(req.params.name);
        const likerId = req.headers['x-character-key'] || 'anonymous';
        
        const newCount = likesDB.addLike(characterId, likerId);
        
        // Log activity for new likes only
        if (newCount > (likesDB.getLikeCount(characterId) - 1)) {
            try {
                const filePath = path.join(profilesDir, `${characterId}.json`);
                if (fs.existsSync(filePath)) {
                    const profile = await readProfileAsync(filePath);
                    activityDB.logActivity('like', `LIKED: ${profile.CharacterName || characterId}`, {
                        characterId,
                        characterName: profile.CharacterName || characterId,
                        likerId,
                        newCount
                    });
                }
            } catch (err) {
                // Silent fail for activity logging
            }
        }
        
        const filePath = path.join(profilesDir, `${characterId}.json`);
        if (fs.existsSync(filePath)) {
            try {
                const profile = await readProfileAsync(filePath);
                profile.LikeCount = newCount;
                profile.LastUpdated = new Date().toISOString();
                await atomicWriteProfile(filePath, profile);
            } catch (err) {
                console.error('Failed to update profile file, but like saved to database:', err);
            }
        }

        galleryCache = null;
        allProfilesCache = null;
        res.json({ LikeCount: newCount });
        
    } catch (err) {
        console.error('Like error:', err);
        res.status(500).json({ error: 'Failed to like profile' });
    }
});

app.delete("/gallery/:name/like", async (req, res) => {
    try {
        const characterId = decodeURIComponent(req.params.name);
        const likerId = req.headers['x-character-key'] || 'anonymous';
        
        const newCount = likesDB.removeLike(characterId, likerId);
        
        const filePath = path.join(profilesDir, `${characterId}.json`);
        if (fs.existsSync(filePath)) {
            try {
                const profile = await readProfileAsync(filePath);
                profile.LikeCount = newCount;
                profile.LastUpdated = new Date().toISOString();
                await atomicWriteProfile(filePath, profile);
            } catch (err) {
                console.error('Failed to update profile file, but unlike saved to database:', err);
            }
        }

        galleryCache = null;
        allProfilesCache = null;
        res.json({ LikeCount: newCount });
        
    } catch (err) {
        console.error('Unlike error:', err);
        res.status(500).json({ error: 'Failed to unlike profile' });
    }
});

// Friends endpoints
app.post("/friends/update-follows", async (req, res) => {
    try {
        const { character, following } = req.body;
        
        if (!character || !Array.isArray(following)) {
            return res.status(400).json({ error: "Invalid request data" });
        }

        friendsDB.updateFriends(character, following);
        
        const followsFile = path.join(profilesDir, `${character}_follows.json`);
        const followsData = {
            character: character,
            following: following,
            lastUpdated: new Date().toISOString()
        };
        
        try {
            await atomicWriteProfile(followsFile, followsData);
        } catch (err) {
            console.error('Failed to write friends backup file:', err);
        }
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('Update friends error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post("/friends/check-mutual", async (req, res) => {
    try {
        const { character } = req.body;
        
        if (!character) {
            return res.status(400).json({ error: "Invalid request data" });
        }

        const mutualFriends = friendsDB.getMutualFriends(character);
        res.json({ mutualFriends });
        
    } catch (error) {
        console.error('Check mutual error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// =============================================================================
// MODERATION ENDPOINTS
// =============================================================================

// Get active announcements (public)
app.get("/announcements", (req, res) => {
    try {
        const announcements = announcementsDB.getActiveAnnouncements();
        res.json(announcements);
    } catch (error) {
        console.error('Get announcements error:', error);
        res.status(500).json({ error: 'Failed to get announcements' });
    }
});

// Create announcement (admin only)
app.post("/admin/announcements", requireAdmin, (req, res) => {
    try {
        const { title, message, type } = req.body;
        
        if (!title || !message) {
            return res.status(400).json({ error: 'Title and message are required' });
        }

        const announcement = announcementsDB.addAnnouncement(title, message, type);
        res.json(announcement);
    } catch (error) {
        console.error('Create announcement error:', error);
        res.status(500).json({ error: 'Failed to create announcement' });
    }
});

// Get all announcements (admin only)
app.get("/admin/announcements", requireAdmin, (req, res) => {
    try {
        const announcements = announcementsDB.getAllAnnouncements();
        res.json(announcements);
    } catch (error) {
        console.error('Get all announcements error:', error);
        res.status(500).json({ error: 'Failed to get announcements' });
    }
});

// Deactivate announcement (admin only)
app.patch("/admin/announcements/:id/deactivate", requireAdmin, (req, res) => {
    try {
        const { id } = req.params;
        const success = announcementsDB.deactivateAnnouncement(id);
        
        if (success) {
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Announcement not found' });
        }
    } catch (error) {
        console.error('Deactivate announcement error:', error);
        res.status(500).json({ error: 'Failed to deactivate announcement' });
    }
});

// Delete announcement (admin only)
app.delete("/admin/announcements/:id", requireAdmin, (req, res) => {
    try {
        const { id } = req.params;
        const success = announcementsDB.deleteAnnouncement(id);
        
        if (success) {
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Announcement not found' });
        }
    } catch (error) {
        console.error('Delete announcement error:', error);
        res.status(500).json({ error: 'Failed to delete announcement' });
    }
});

// Submit report (public)
app.post("/reports", (req, res) => {
    try {
        const { reportedCharacterId, reportedCharacterName, reporterCharacter, reason, details, offensiveCSName } = req.body;

        if (!reportedCharacterId || !reporterCharacter || !reason) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const report = reportsDB.addReport(
            reportedCharacterId,
            reportedCharacterName || reportedCharacterId,
            reporterCharacter,
            reason,
            details,
            offensiveCSName
        );

        // Log activity
        activityDB.logActivity('report', `REPORTED: ${reportedCharacterName || reportedCharacterId} (CS+: ${offensiveCSName || 'N/A'})`, {
            reportId: report.id,
            reportedCharacterId,
            reportedCharacterName: reportedCharacterName || reportedCharacterId,
            offensiveCSName,
            reporterCharacter,
            reason
        });
        
        res.json({ success: true, reportId: report.id });
    } catch (error) {
        console.error('Submit report error:', error);
        res.status(500).json({ error: 'Failed to submit report' });
    }
});

// Get reports (admin only)
app.get("/admin/reports", requireAdmin, (req, res) => {
    try {
        const { status } = req.query;
        const reports = reportsDB.getReports(status);
        res.json(reports);
    } catch (error) {
        console.error('Get reports error:', error);
        res.status(500).json({ error: 'Failed to get reports' });
    }
});

// Update report status (admin only)
app.patch("/admin/reports/:id", requireAdmin, (req, res) => {
    try {
        const { id } = req.params;
        const { status, adminNotes } = req.body;
        const adminId = req.adminId;
        
        if (!status) {
            return res.status(400).json({ error: 'Status is required' });
        }

        const success = reportsDB.updateReportStatus(id, status, adminNotes, adminId);
        
        if (success) {
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Report not found' });
        }
    } catch (error) {
        console.error('Update report error:', error);
        res.status(500).json({ error: 'Failed to update report' });
    }
});

// Remove profile (admin only)
app.delete("/admin/profiles/:characterId", requireAdmin, async (req, res) => {
    try {
        const characterId = decodeURIComponent(req.params.characterId);
        const { reason, ban } = req.body;
        const adminId = req.adminId;
        
        const filePath = path.join(profilesDir, `${characterId}.json`);
        
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'Profile not found' });
        }

        let characterName = characterId;
        let physicalName = null;
        try {
            const profile = await readProfileAsync(filePath);
            characterName = profile.CharacterName || characterId;
            // Derive physical name from profile's CS+ name — more reliable than extractPhysicalName
            // when CS+ names contain special chars (sanitised to underscores in characterId)
            if (profile.CharacterName) {
                const sanitizedCS = profile.CharacterName.replace(/[^\w\s\-.']/g, '_');
                const prefix = sanitizedCS + '_';
                if (characterId.startsWith(prefix)) {
                    physicalName = characterId.substring(prefix.length);
                }
            }
        } catch (err) {
            // Use characterId as fallback
        }
        // Fallback to heuristic extraction
        if (!physicalName) {
            physicalName = moderationDB.extractPhysicalName(characterId);
        }

        // Delete the profile file
        fs.unlinkSync(filePath);

        // Remove associated image if exists
        try {
            const imageFiles = fs.readdirSync(imagesDir);
            const associatedImage = imageFiles.find(file => file.startsWith(characterId.replace(/[^\w@\-_.]/g, "_")));
            if (associatedImage) {
                fs.unlinkSync(path.join(imagesDir, associatedImage));
                console.log(`🗑️ Deleted associated image: ${associatedImage}`);
            }
        } catch (err) {
            console.error('Error deleting associated image:', err);
        }

        moderationDB.logAction('remove', characterId, characterName, reason || 'No reason provided', adminId);

        if (ban) {
            // Ban both the profile and the physical user
            moderationDB.bannedProfiles.add(characterId);
            if (physicalName) {
                moderationDB.bannedUsers.add(physicalName);
            }
            moderationDB.save();
            moderationDB.logAction('ban', characterId, characterName, reason || 'No reason provided', adminId);
        }

        galleryCache = null;
        allProfilesCache = null;
        invalidateNamesCache();
        invalidateProfilesLookupCache();

        console.log(`🛡️ Profile ${characterName} removed by ${adminId}${ban ? ' and banned' : ''}`);
        res.json({ success: true, banned: !!ban });
        
    } catch (error) {
        console.error('Remove profile error:', error);
        res.status(500).json({ error: 'Failed to remove profile' });
    }
});

// Update profile NSFW status (admin only)
app.patch("/admin/profiles/:characterId/nsfw", requireAdmin, async (req, res) => {
    try {
        const characterId = decodeURIComponent(req.params.characterId);
        const { isNSFW } = req.body;
        const adminId = req.adminId;
        
        const filePath = path.join(profilesDir, `${characterId}.json`);
        
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'Profile not found' });
        }

        // Read current profile
        const profile = await readProfileAsync(filePath);
        
        // Update NSFW status
        profile.IsNSFW = isNSFW;
        profile.LastUpdated = new Date().toISOString();
        
        // Save updated profile
        await atomicWriteProfile(filePath, profile);
        
        // Log moderation action
        moderationDB.logAction(
            isNSFW ? 'mark_nsfw' : 'unmark_nsfw', 
            characterId, 
            profile.CharacterName || characterId, 
            `Profile ${isNSFW ? 'marked as' : 'unmarked from'} NSFW`, 
            adminId
        );
        
        // Clear caches to reflect changes
        galleryCache = null;
        allProfilesCache = null;
        invalidateNamesCache();
        invalidateProfilesLookupCache();

        console.log(`🛡️ Profile ${profile.CharacterName} ${isNSFW ? 'marked as' : 'unmarked from'} NSFW by ${adminId}`);
        res.json({ success: true, isNSFW });

    } catch (error) {
        console.error('Update NSFW status error:', error);
        res.status(500).json({ error: 'Failed to update NSFW status' });
    }
});

// Ban profile (admin only)
app.post("/admin/profiles/:characterId/ban", requireAdmin, (req, res) => {
    try {
        const characterId = decodeURIComponent(req.params.characterId);
        const { reason } = req.body;
        const adminId = req.adminId;
        
        moderationDB.banProfile(characterId);
        moderationDB.logAction('ban', characterId, characterId, reason || 'No reason provided', adminId);
        
        console.log(`🛡️ Profile ${characterId} banned by ${adminId}`);
        res.json({ success: true });
        
    } catch (error) {
        console.error('Ban profile error:', error);
        res.status(500).json({ error: 'Failed to ban profile' });
    }
});

// Unban profile (admin only) - legacy endpoint for characterId-based unbans
app.post("/admin/profiles/:characterId/unban", requireAdmin, (req, res) => {
    try {
        const characterId = decodeURIComponent(req.params.characterId);
        const { reason } = req.body;
        const adminId = req.adminId;

        // Check if this looks like a physical name (contains @ but no underscore before it)
        // Physical names: "John Smith@Balmung"
        // CharacterIds: "CS_Name_John Smith@Balmung"
        const underscoreIndex = characterId.indexOf('_');
        const atIndex = characterId.indexOf('@');

        if (atIndex > 0 && (underscoreIndex < 0 || underscoreIndex > atIndex)) {
            // This is a physical name, unban the user directly
            moderationDB.unbanUser(characterId);
            moderationDB.logAction('unban', characterId, characterId, reason || 'No reason provided', adminId);
            console.log(`🛡️ User ${characterId} unbanned by ${adminId}`);
        } else {
            // This is a characterId, use the old method
            moderationDB.unbanProfile(characterId);
            moderationDB.logAction('unban', characterId, characterId, reason || 'No reason provided', adminId);
            console.log(`🛡️ Profile ${characterId} unbanned by ${adminId}`);
        }

        res.json({ success: true });

    } catch (error) {
        console.error('Unban profile error:', error);
        res.status(500).json({ error: 'Failed to unban profile' });
    }
});

// Get moderation actions (admin only)
app.get("/admin/moderation/actions", requireAdmin, (req, res) => {
    try {
        const actions = moderationDB.getActions();
        res.json(actions);
    } catch (error) {
        console.error('Get moderation actions error:', error);
        res.status(500).json({ error: 'Failed to get moderation actions' });
    }
});

// Get banned users (admin only) - returns physical names banned from uploading
app.get("/admin/moderation/banned", requireAdmin, (req, res) => {
    try {
        const bannedUsers = moderationDB.getBannedUsers();
        res.json(bannedUsers);
    } catch (error) {
        console.error('Get banned users error:', error);
        res.status(500).json({ error: 'Failed to get banned users' });
    }
});

// ===============================
// 🚫 NAME BAN ENDPOINTS (3-STRIKE SYSTEM)
// ===============================
// Ban user from CS+ Names feature with strike tracking
app.post("/admin/names/ban", requireAdmin, (req, res) => {
    try {
        const { physicalName, reason, offensiveCSName } = req.body;
        const adminId = req.adminId;

        if (!physicalName) {
            return res.status(400).json({ error: 'Physical name required' });
        }

        // Add to ban list
        moderationDB.banFromNames(physicalName);

        // Create warning with strike tracking
        const warning = moderationDB.addNameWarning(physicalName, offensiveCSName || '[Unknown]', adminId);

        // Log the action
        moderationDB.logAction('name_ban', physicalName, offensiveCSName || physicalName, reason || 'Offensive CS+ name', adminId);

        console.log(`🚫 NAME BAN: ${physicalName} (CS+ name: ${offensiveCSName || 'N/A'}) - Strike ${warning.strikeNumber} by ${adminId}`);

        res.json({
            success: true,
            message: `${physicalName} banned from names feature`,
            warning: {
                id: warning.id,
                strikeNumber: warning.strikeNumber,
                status: warning.status
            }
        });
    } catch (error) {
        console.error('Name ban error:', error);
        res.status(500).json({ error: 'Failed to ban user from names' });
    }
});

// Unban user from CS+ Names feature
app.post("/admin/names/unban", requireAdmin, (req, res) => {
    try {
        const { physicalName } = req.body;
        const adminId = req.adminId;

        if (!physicalName) {
            return res.status(400).json({ error: 'Physical name required' });
        }

        moderationDB.unbanFromNames(physicalName);
        moderationDB.logAction('name_unban', physicalName, physicalName, 'Unbanned from names', adminId);

        console.log(`✅ NAME UNBAN: ${physicalName} by ${adminId}`);

        res.json({ success: true, message: `${physicalName} unbanned from names feature` });
    } catch (error) {
        console.error('Name unban error:', error);
        res.status(500).json({ error: 'Failed to unban user from names' });
    }
});

// Get list of name-banned users
app.get("/admin/moderation/namebanned", requireAdmin, (req, res) => {
    try {
        const nameBannedUsers = moderationDB.getNameBannedUsers();
        res.json(nameBannedUsers);
    } catch (error) {
        console.error('Get name-banned users error:', error);
        res.status(500).json({ error: 'Failed to get name-banned users' });
    }
});

// Get name warnings (admin) - supports status filtering
app.get("/admin/names/warnings", requireAdmin, (req, res) => {
    try {
        const { status } = req.query;
        let warnings = moderationDB.getAllNameWarnings();

        if (status === 'active') {
            // Active warnings: not resolved (still needs action or is permaban)
            warnings = warnings.filter(w => !w.resolved);
        } else if (status === 'resolved') {
            // Resolved warnings: user successfully changed name and it was approved
            warnings = warnings.filter(w => w.resolved);
        }
        // Default: return all warnings

        res.json(warnings);
    } catch (error) {
        console.error('Get name warnings error:', error);
        res.status(500).json({ error: 'Failed to get name warnings' });
    }
});

// Get pending review warnings (admin) - strike 2 users who changed names and need approval
app.get("/admin/names/pending-review", requireAdmin, (req, res) => {
    try {
        const pendingWarnings = moderationDB.getPendingReviewWarnings();
        res.json(pendingWarnings);
    } catch (error) {
        console.error('Get pending review warnings error:', error);
        res.status(500).json({ error: 'Failed to get pending review warnings' });
    }
});

// Get resolved reviews (admin) - approved or rejected name changes
app.get("/admin/names/resolved-reviews", requireAdmin, (req, res) => {
    try {
        const allWarnings = moderationDB.getAllNameWarnings();
        // Resolved reviews: had pendingReview at some point and now resolved or rejected
        const resolvedReviews = allWarnings.filter(w =>
            w.resolved || // Approved
            (w.rejectionReason && !w.pendingReview) // Rejected
        );
        res.json(resolvedReviews);
    } catch (error) {
        console.error('Get resolved reviews error:', error);
        res.status(500).json({ error: 'Failed to get resolved reviews' });
    }
});

// Approve name change (admin) - for strike 2 users
app.post("/admin/names/approve/:warningId", requireAdmin, (req, res) => {
    try {
        const { warningId } = req.params;
        const success = moderationDB.approveNameChange(warningId);

        if (success) {
            res.json({ success: true, message: 'Name change approved' });
        } else {
            res.status(404).json({ error: 'Warning not found or not pending review' });
        }
    } catch (error) {
        console.error('Approve name change error:', error);
        res.status(500).json({ error: 'Failed to approve name change' });
    }
});

// Reject name change (admin) - for strike 2 users
app.post("/admin/names/reject/:warningId", requireAdmin, (req, res) => {
    try {
        const { warningId } = req.params;
        const { reason } = req.body;
        const success = moderationDB.rejectNameChange(warningId, reason || 'Name still inappropriate');

        if (success) {
            res.json({ success: true, message: 'Name change rejected' });
        } else {
            res.status(404).json({ error: 'Warning not found or not pending review' });
        }
    } catch (error) {
        console.error('Reject name change error:', error);
        res.status(500).json({ error: 'Failed to reject name change' });
    }
});

// Get names cache contents (admin)
app.get("/admin/names/cache", requireAdmin, async (req, res) => {
    try {
        // Rebuild cache if stale or missing
        const now = Date.now();
        if (!namesCache || (now - namesCacheTime) > NAMES_CACHE_DURATION) {
            await rebuildNamesCache();
        }

        // Convert Map to array for JSON response
        const cacheEntries = [];
        if (namesCache) {
            for (const [physicalName, data] of namesCache) {
                cacheEntries.push({
                    physicalName: physicalName,
                    csName: data.csName,
                    nameplateColor: data.nameplateColor
                });
            }
        }

        // Sort alphabetically by CS+ name
        cacheEntries.sort((a, b) => a.csName.localeCompare(b.csName));

        res.json({
            count: cacheEntries.length,
            cacheAge: namesCache ? Math.floor((now - namesCacheTime) / 1000) : null,
            entries: cacheEntries
        });
    } catch (error) {
        console.error('Get names cache error:', error);
        res.status(500).json({ error: 'Failed to get names cache' });
    }
});

// ===============================
// 👤 USER WARNING ENDPOINTS (Public)
// ===============================
// Get warnings for a user (plugin calls this on startup)
app.get("/user/warnings/:physicalName", (req, res) => {
    try {
        const { physicalName } = req.params;

        if (!physicalName) {
            return res.status(400).json({ error: 'Physical name required' });
        }

        // Get unacknowledged warnings
        const unacknowledgedWarnings = moderationDB.getUnacknowledgedWarnings(physicalName);

        // Get active warning (if any)
        const activeWarning = moderationDB.getActiveWarning(physicalName);

        // Get strike count
        const strikeCount = moderationDB.getUserStrikeCount(physicalName);

        res.json({
            hasUnacknowledgedWarning: unacknowledgedWarnings.length > 0,
            unacknowledgedWarnings,
            activeWarning,
            strikeCount,
            isPermabanned: moderationDB.isPermabanned(physicalName)
        });
    } catch (error) {
        console.error('Get user warnings error:', error);
        res.status(500).json({ error: 'Failed to get warnings' });
    }
});

// Acknowledge a warning (user clicked checkbox + accept)
app.post("/user/warnings/:warningId/acknowledge", (req, res) => {
    try {
        const { warningId } = req.params;

        const success = moderationDB.acknowledgeWarning(warningId);

        if (success) {
            res.json({ success: true, message: 'Warning acknowledged' });
        } else {
            res.status(404).json({ error: 'Warning not found' });
        }
    } catch (error) {
        console.error('Acknowledge warning error:', error);
        res.status(500).json({ error: 'Failed to acknowledge warning' });
    }
});

// Check if name change resolves warning (called when user updates their CS+ name)
app.post("/user/check-name-change", (req, res) => {
    try {
        const { physicalName, newCSName } = req.body;

        if (!physicalName || !newCSName) {
            return res.status(400).json({ error: 'Physical name and new CS+ name required' });
        }

        const result = moderationDB.checkNameChange(physicalName, newCSName);

        res.json({
            resolved: result.resolved,
            needsReview: result.needsReview,
            message: result.resolved
                ? 'Your name has been restored!'
                : result.needsReview
                    ? 'Your new name is pending admin review.'
                    : result.warning?.status === 'permaban'
                        ? 'You are permanently banned from the names feature.'
                        : 'No active warning found.'
        });
    } catch (error) {
        console.error('Check name change error:', error);
        res.status(500).json({ error: 'Failed to check name change' });
    }
});

// Admin dashboard endpoint
app.get("/admin/dashboard", requireAdmin, async (req, res) => {
    try {
        // Time thresholds for tracking changes
        const now = new Date();
        const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

        // Count all profiles
        const allProfiles = fs.readdirSync(profilesDir).filter(f => f.endsWith('.json') && !f.endsWith('_follows.json'));

        // Count profiles - both total (AlwaysShare + ShowcasePublic) and gallery (ShowcasePublic only)
        let totalCount = 0;
        let galleryCount = 0;
        let newProfilesToday = 0;
        let newProfilesThisWeek = 0;
        let newGalleryProfilesToday = 0;

        for (const file of allProfiles) {
            try {
                const characterId = file.replace('.json', '');
                if (moderationDB.isProfileBanned(characterId)) continue;

                const filePath = path.join(profilesDir, file);
                const profileData = await readProfileAsync(filePath);

                if (!isValidProfile(profileData)) continue;

                const isShowcasePublic = profileData.Sharing === 'ShowcasePublic' || profileData.Sharing === 2;
                const isAlwaysShare = profileData.Sharing === 'AlwaysShare' || profileData.Sharing === 0;

                // Count total (both AlwaysShare and ShowcasePublic)
                if (isShowcasePublic || isAlwaysShare) {
                    totalCount++;

                    // Check if profile is new (only count profiles with CreatedAt for accuracy)
                    if (profileData.CreatedAt) {
                        const createdDate = new Date(profileData.CreatedAt);
                        if (createdDate > oneDayAgo) {
                            newProfilesToday++;
                        }
                        if (createdDate > oneWeekAgo) {
                            newProfilesThisWeek++;
                        }
                    }
                }

                // Count gallery (ShowcasePublic only)
                if (isShowcasePublic) {
                    galleryCount++;

                    if (profileData.CreatedAt) {
                        const createdDate = new Date(profileData.CreatedAt);
                        if (createdDate > oneDayAgo) {
                            newGalleryProfilesToday++;
                        }
                    }
                }
            } catch (err) {
                // Skip invalid profiles
                continue;
            }
        }

        // Count new reports
        const allReports = reportsDB.getReports();
        const pendingReports = reportsDB.getReports('pending');
        const newReportsToday = allReports.filter(r => new Date(r.createdAt) > oneDayAgo).length;
        const newReportsThisWeek = allReports.filter(r => new Date(r.createdAt) > oneWeekAgo).length;

        // Count new warnings
        const allWarnings = moderationDB.getAllNameWarnings();
        const newWarningsToday = allWarnings.filter(w => new Date(w.createdAt) > oneDayAgo).length;

        // Count new flagged profiles
        const allFlagged = autoFlagDB.getFlaggedProfiles();
        const pendingFlags = autoFlagDB.getFlaggedProfiles('pending');
        const newFlaggedToday = allFlagged.filter(f => new Date(f.flaggedAt) > oneDayAgo).length;

        const stats = {
            totalProfiles: totalCount,
            galleryProfiles: galleryCount,
            newProfilesToday,
            newGalleryProfilesToday,
            newProfilesThisWeek,
            totalReports: allReports.length,
            pendingReports: pendingReports.length,
            newReportsToday,
            newReportsThisWeek,
            totalBanned: moderationDB.bannedUsers.size,
            totalAnnouncements: announcementsDB.getAllAnnouncements().length,
            activeAnnouncements: announcementsDB.getActiveAnnouncements().length,
            recentActions: moderationDB.getActions().slice(0, 10),
            pendingFlags: pendingFlags.length,
            newFlaggedToday,
            totalWarnings: allWarnings.length,
            newWarningsToday
        };

        res.json(stats);
    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).json({ error: 'Failed to get dashboard data' });
    }
});

// Activity Feed endpoints
app.get("/admin/activity", requireAdmin, (req, res) => {
    try {
        const { type, limit } = req.query;
        let activities;
        
        if (type) {
            activities = activityDB.getActivitiesByType(type, parseInt(limit) || 50);
        } else {
            activities = activityDB.getActivities(parseInt(limit) || 50);
        }
        
        res.json(activities);
    } catch (error) {
        console.error('Get activity error:', error);
        res.status(500).json({ error: 'Failed to get activity' });
    }
});

// Auto-flagging endpoints
app.get("/admin/flagged", requireAdmin, (req, res) => {
    try {
        const { status } = req.query;
        const flaggedProfiles = autoFlagDB.getFlaggedProfiles(status);
        res.json(flaggedProfiles);
    } catch (error) {
        console.error('Get flagged profiles error:', error);
        res.status(500).json({ error: 'Failed to get flagged profiles' });
    }
});

app.patch("/admin/flagged/:id", requireAdmin, (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        const adminId = req.adminId;
        
        const success = autoFlagDB.updateFlagStatus(id, status, adminId);
        
        if (success) {
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Flag not found' });
        }
    } catch (error) {
        console.error('Update flag status error:', error);
        res.status(500).json({ error: 'Failed to update flag status' });
    }
});

app.post("/admin/flagged/keywords", requireAdmin, (req, res) => {
    try {
        const { keyword } = req.body;
        
        if (!keyword || typeof keyword !== 'string') {
            return res.status(400).json({ error: 'Valid keyword is required' });
        }
        
        const success = autoFlagDB.addKeyword(keyword);
        
        if (success) {
            res.json({ success: true, message: 'Keyword added' });
        } else {
            res.status(400).json({ error: 'Keyword already exists' });
        }
    } catch (error) {
        console.error('Add keyword error:', error);
        res.status(500).json({ error: 'Failed to add keyword' });
    }
});

app.delete("/admin/flagged/keywords/:keyword", requireAdmin, (req, res) => {
    try {
        const { keyword } = req.params;
        const success = autoFlagDB.removeKeyword(decodeURIComponent(keyword));
        
        if (success) {
            res.json({ success: true, message: 'Keyword removed' });
        } else {
            res.status(404).json({ error: 'Keyword not found' });
        }
    } catch (error) {
        console.error('Remove keyword error:', error);
        res.status(500).json({ error: 'Failed to remove keyword' });
    }
});

// =============================================================================
// NAME SYNC EXPIRY CONSTANT (24-hour TTL - checked at query time, NOT deletion)
// =============================================================================

const NAME_SYNC_EXPIRY_HOURS = 24;

// =============================================================================
// GLOBAL ERROR HANDLER (catches body-parser aborted requests)
// =============================================================================

app.use((err, req, res, next) => {
    // Silently ignore aborted requests (client disconnected)
    if (err.type === 'request.aborted' || err.code === 'ECONNRESET') {
        return;
    }
    // Log other errors but don't spam
    console.error(`[Error] ${req.method} ${req.path}: ${err.message}`);
    if (!res.headersSent) {
        res.status(500).json({ error: 'Server error' });
    }
});

// =============================================================================
// SERVER STARTUP
// =============================================================================

app.listen(PORT, () => {
    console.log(`✅ Character Select+ RP server running at http://localhost:${PORT}`);
    console.log(`📁 Profiles directory: ${profilesDir}`);
    console.log(`🖼️ Images directory: ${imagesDir}`);
    console.log(`🛡️ Admin dashboard: http://localhost:${PORT}/admin`);
    console.log(`💾 Database files: ${likesDbFile}, ${friendsDbFile}, ${announcementsDbFile}, ${reportsDbFile}, ${moderationDbFile}, ${activityDbFile}, ${flaggedDbFile}`);
    console.log(`🚀 Features: Gallery, Likes, Friends, Announcements, Reports, Visual Moderation Dashboard, Activity Feed, Auto-Flagging`);
    console.log(`🧹 Name Sync expiry: Names hidden after ${NAME_SYNC_EXPIRY_HOURS}h inactivity (profiles preserved for RP/Gallery)`);
    console.log(`🗂️ Using data directory: ${DATA_DIR}`);

    if (process.env.ADMIN_SECRET_KEY) {
        console.log(`👑 Admin access enabled - visit /admin to moderate`);
    } else {
        console.log(`⚠️  Admin access disabled - set ADMIN_SECRET_KEY environment variable to enable`);
    }

    // Pre-warm caches sequentially so they don't all compete for disk I/O
    console.log(`🔄 Pre-warming caches...`);
    (async () => {
        try {
            await rebuildNamesCache(true);
            console.log(`✅ Names cache pre-warmed`);
            await rebuildProfilesLookupCache(true);
            console.log(`✅ Profiles lookup cache pre-warmed`);
            await rebuildGalleryCache(true);
            console.log(`✅ Gallery cache pre-warmed`);
            await rebuildAllProfilesCache(true);
            console.log(`✅ All profiles cache pre-warmed`);
            console.log(`🔄 All caches ready`);
        } catch (err) {
            console.error(`⚠️ Cache pre-warm failed: ${err}`);
        }
    })();
});
