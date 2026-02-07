// ===========================================
// TOPSIDE TRACKER - BACKEND SERVER
// ===========================================
// Installation:
// 1. Run: npm install
// 2. Copy .env.example to .env
// 3. Fill in your Supabase credentials in .env
// 4. Run: npm start (or npm run dev for development)

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { v4: uuidv4, validate: uuidValidate } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// ===========================================
// SUPABASE INITIALIZATION
// ===========================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
    console.error('ERROR: Missing Supabase credentials in .env file');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

// ===========================================
// MIDDLEWARE
// ===========================================

// CORS configuration
const allowedOrigins = [
    'http://localhost:3000',
    'https://v1-deploy.github.io',  // Your actual GitHub Pages URL
    'http://127.0.0.1:5500'
];

app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (mobile apps, Postman, etc.)
        if (!origin) return callback(null, true);
        
        if (allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            console.log('Blocked by CORS:', origin);
            callback(new Error('Not allowed by CORS'));
        }
    },
    methods: ['GET', 'POST'],
    credentials: true
}));

// Parse JSON bodies
app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, '../frontend')));

// Rate limiting - prevent abuse
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.'
});

const reportLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 50, // Limit each IP to 50 reports per hour
    message: 'Too many reports submitted. Please try again later.'
});

app.use('/api/', apiLimiter);

// ===========================================
// VALIDATION FUNCTIONS
// ===========================================

/**
 * Validates Embark ID format
 * Rules: 3-16 characters, A-Z, a-z, 0-9, underscore, hash
 */
function validateEmbarkId(id) {
    if (!id || typeof id !== 'string') return false;
    const regex = /^[A-Za-z0-9_]{3,16}#\d{4}$/;
    return regex.test(id);
}

/**
 * Validates reporter UUID format
 */
function validateReporterId(id) {
    return uuidValidate(id);
}

/**
 * Validates report type
 */
function validateReportType(type) {
    const validTypes = ['aimbot', 'wallhack', 'macro', 'glitch', 'goodplayer'];
    return validTypes.includes(type);
}

// ===========================================
// API ROUTES
// ===========================================

/**
 * GET /api/health
 * Health check endpoint
 */
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'Topside Tracker API is running' });
});

/**
 * POST /api/reports/submit
 * Submit a new report
 */
app.post('/api/reports/submit', reportLimiter, async (req, res) => {
    try {
        const { embarkId, reportType, reporterId } = req.body;

        // Validate all inputs
        if (!validateEmbarkId(embarkId)) {
            return res.status(400).json({
                success: false,
                error: "The ID entered does not follow Embark ID's proper format"
            });
        }

        if (!validateReporterId(reporterId)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid reporter ID'
            });
        }

        if (!validateReportType(reportType)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid report type'
            });
        }

        // Check for duplicate reports (same reporter, same embark_id, within 24 hours)
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { data: duplicateCheck, error: duplicateError } = await supabase
            .from('report_table')
            .select('id')
            .eq('embark_id', embarkId)
            .eq('reporter_id', reporterId)
            .eq('report_type', reportType)
            .gte('created_at', oneDayAgo);

        if (duplicateError) {
            console.error('Duplicate check error:', duplicateError);
            return res.status(500).json({
                success: false,
                error: 'Database error occurred'
            });
        }

        if (duplicateCheck && duplicateCheck.length > 0) {
            return res.status(429).json({
                success: false,
                error: 'You have already submitted this report recently'
            });
        }

        // Insert the report
        const { data, error } = await supabase
            .from('report_table')
            .insert([{
                embark_id: embarkId,
                report_type: reportType,
                reporter_id: reporterId
            }])
            .select();

        if (error) {
            console.error('Insert error:', error);
            return res.status(500).json({
                success: false,
                error: 'Failed to submit report'
            });
        }

        res.json({
            success: true,
            message: 'Report submitted successfully',
            data: data[0]
        });

    } catch (error) {
        console.error('Submit report error:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

    /**
     * GET /api/reports/:embarkId
     * Get report counts for a specific Embark ID using the database function
     */
        app.get('/api/reports/:embarkId', async (req, res) => {
            try {
                const { embarkId } = req.params;

                // Validate Embark ID format
                if (!validateEmbarkId(embarkId)) {
                    return res.status(400).json({
                        success: false,
                        error: "The ID entered does not follow Embark ID's proper format"
                    });
                }

                // Call the database function for aggregated data
                const { data, error } = await supabase
                    .rpc('get_report_summary', { search_embark_id: embarkId });

                if (error) {
                    console.error('Query error:', error);
                    return res.status(500).json({
                        success: false,
                        error: 'Failed to retrieve reports'
                    });
                }

                // If no results, return zeros
                if (!data || data.length === 0) {
                    return res.json({
                        success: true,
                        embarkId: embarkId,
                        exists: false,
                        counts: {
                            aimbot: 0,
                            wallhack: 0,
                            macro: 0,
                            glitch: 0,
                            goodplayer: 0
                        },
                        totalNegative: 0,
                        totalAll: 0
                    });
                }

                // Return aggregated data from the database function
                const result = data[0];
                const totalNegative = Number(result.aimbot_count) + 
                                    Number(result.wallhack_count) + 
                                    Number(result.macro_count) + 
                                    Number(result.glitch_count);

                res.json({
                    success: true,
                    embarkId: result.embark_id,
                    exists: true,
                    counts: {
                        aimbot: Number(result.aimbot_count),
                        wallhack: Number(result.wallhack_count),
                        macro: Number(result.macro_count),
                        glitch: Number(result.glitch_count),
                        goodplayer: Number(result.goodplayer_count)
                    },
                    totalNegative: totalNegative,
                    totalAll: Number(result.total_reports),
                    firstReported: result.first_reported,
                    lastReported: result.last_reported,
                    uniqueReporters: Number(result.unique_reporters)
                });

            } catch (error) {
                console.error('Get reports error:', error);
                res.status(500).json({
                    success: false,
                    error: 'Internal server error'
                });
            }
        });

/**
 * GET /api/reports/:embarkId/history
 * Get report history for trends chart (last 30 days)
 */
app.get('/api/reports/:embarkId/history', async (req, res) => {
    try {
        const { embarkId } = req.params;

        if (!validateEmbarkId(embarkId)) {
            return res.status(400).json({
                success: false,
                error: "Invalid Embark ID format"
            });
        }

        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

        const { data, error } = await supabase
            .from('report_table')
            .select('report_type, created_at')
            .eq('embark_id', embarkId)
            .gte('created_at', thirtyDaysAgo)
            .order('created_at', { ascending: true });

        if (error) {
            console.error('History query error:', error);
            return res.status(500).json({
                success: false,
                error: 'Failed to retrieve report history'
            });
        }

        res.json({
            success: true,
            history: data
        });

    } catch (error) {
        console.error('Get history error:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// ===========================================
// SERVE FRONTEND ROUTES
// ===========================================

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

app.get('/report', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/report.html'));
});

app.get('/mission', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/mission.html'));
});

app.get('/contact', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/contact.html'));
});

app.get('/support', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/support.html'));
});

app.get('/privacy', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/privacy.html'));
});

app.get('/terms', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/terms.html'));
});

// ===========================================
// ERROR HANDLING
// ===========================================

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Route not found'
    });
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('Global error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal server error'
    });
});

// ===========================================
// START SERVER THIS NEEDS TO BE UPDATED FOR DEPLOYMENT
// ===========================================

app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════╗
║   TOPSIDE TRACKER API                 ║
║   Server running on port ${PORT}        ║
║   Frontend: http://localhost:${PORT}     ║
║   API: http://localhost:${PORT}/api      ║
╚═══════════════════════════════════════╝
    `);
});