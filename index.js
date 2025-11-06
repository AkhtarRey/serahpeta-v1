const express = require('express')
const app = express()
const port = 3000

const cors = require('cors')

const { chromium } = require('playwright');

const getChromePath = () => {
    let chromePath = process.env.PLAYWRIGHT_CHROME_PATH;

    if (chromePath) {
        console.log(`Menggunakan Chrome dari variabel lingkungan: ${chromePath}`);
        return chromePath;
    } else {
        console.log('Variabel lingkungan PLAYWRIGHT_CHROME_PATH tidak ditemukan. Playwright akan mencoba mendeteksi Chrome secara otomatis.');
        return undefined;
    }
}

let browser = null; // Store browser instance globally

// Global object to store automation states
global.automationStates = {};

// Queue management
global.automationQueue = [];
global.isProcessingQueue = false;
global.currentJob = null;

app.use(express.json());
app.use(cors());

// SSE endpoint for progress updates
app.get('/automation_progress/:sessionId', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Store the response object for this session
    const sessionId = req.params.sessionId;
    if (!global.progressClients) {
        global.progressClients = {};
    }
    global.progressClients[sessionId] = res;

    req.on('close', () => {
        delete global.progressClients[sessionId];
    });
});

// Helper function to send progress updates
function sendProgress(sessionId, data) {
    const client = global.progressClients?.[sessionId];
    if (client) {
        client.write(`data: ${JSON.stringify(data)}\n\n`);
    }
}

// Queue status endpoint
app.get('/automation/queue/status', (req, res) => {
    const queueStatus = {
        queueLength: global.automationQueue.length,
        isProcessing: global.isProcessingQueue,
        currentJob: global.currentJob ? {
            sessionId: global.currentJob.sessionId,
            type: global.currentJob.type,
            status: global.currentJob.status,
            totalFiles: global.currentJob.data.filePaths?.length || 0
        } : null,
        queue: global.automationQueue.map(job => ({
            sessionId: job.sessionId,
            type: job.type,
            totalFiles: job.data.filePaths?.length || 0,
            addedAt: job.addedAt
        }))
    };
    res.json(queueStatus);
});

// Remove from queue endpoint
app.delete('/automation/queue/:sessionId', (req, res) => {
    const sessionId = req.params.sessionId;
    const initialLength = global.automationQueue.length;
    
    global.automationQueue = global.automationQueue.filter(job => job.sessionId !== sessionId);
    
    if (global.automationQueue.length < initialLength) {
        res.json({ success: true, message: 'Job removed from queue' });
    } else {
        res.status(404).json({ success: false, error: 'Job not found in queue' });
    }
});

// Control endpoints
app.post('/automation/pause/:sessionId', (req, res) => {
    const sessionId = req.params.sessionId;
    if (global.automationStates[sessionId]) {
        global.automationStates[sessionId].isPaused = true;
        sendProgress(sessionId, {
            status: 'paused',
            message: 'Automation paused by user'
        });
        res.json({ success: true, message: 'Automation paused' });
    } else {
        res.status(404).json({ success: false, error: 'Session not found' });
    }
});

app.post('/automation/resume/:sessionId', (req, res) => {
    const sessionId = req.params.sessionId;
    if (global.automationStates[sessionId]) {
        global.automationStates[sessionId].isPaused = false;
        sendProgress(sessionId, {
            status: 'resumed',
            message: 'Automation resumed'
        });
        res.json({ success: true, message: 'Automation resumed' });
    } else {
        res.status(404).json({ success: false, error: 'Session not found' });
    }
});

app.post('/automation/abort/:sessionId', (req, res) => {
    const sessionId = req.params.sessionId;
    if (global.automationStates[sessionId]) {
        global.automationStates[sessionId].isAborted = true;
        sendProgress(sessionId, {
            status: 'aborted',
            message: 'Automation aborted by user'
        });
        res.json({ success: true, message: 'Automation aborted' });
    } else {
        res.status(404).json({ success: false, error: 'Session not found' });
    }
});

// Helper function to wait while paused
async function checkPauseAndAbort(sessionId) {
    while (global.automationStates[sessionId]?.isPaused) {
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (global.automationStates[sessionId]?.isAborted) {
        throw new Error('Automation aborted by user');
    }
}

// Core automation function for mbtiles
async function processAutomationMbtiles(sessionId, data) {
    const { resolusi, akurasi, tahunSurvey, sumberData, nomorHP, filePaths } = data;

    if (!browser) {
        throw new Error('Browser not initialized. Please login first.');
    }

    // Initialize automation state
    global.automationStates[sessionId] = {
        isPaused: false,
        isAborted: false
    };

    // Send initial progress
    sendProgress(sessionId, {
        status: 'started',
        total: filePaths.length,
        current: 0,
        message: 'Starting automation...',
        sessionId: sessionId
    });

    const results = [];

    for (let i = 0; i < filePaths.length; i++) {
        try {
            // Check pause/abort status
            await checkPauseAndAbort(sessionId);

            // Report start of current file
            sendProgress(sessionId, {
                status: 'processing',
                total: filePaths.length,
                current: i + 1,
                fileName: filePaths[i],
                message: `Processing file ${i + 1} of ${filePaths.length}...`
            });

            const page = browser.pages()[0];
            await page.click('xpath=/html/body/div[1]/aside/div/nav/ul/li[4]/a')

            const iframe = page.frameLocator('iframe')
            const button_mbtiles = iframe.locator('input[value="Mbtiles Peta Foto Drones"]')
            await button_mbtiles.click()

            await checkPauseAndAbort(sessionId);

            await iframe.locator('input[type="file"]').setInputFiles(filePaths[i]);
            await iframe.getByText(' Registrasi Metadata ').click({ timeout: 99999999999 })

            await iframe.waitForSelector('xpath=//*[@id="f15"]/div[4]/input', { timeout: 99999999999 })

            await checkPauseAndAbort(sessionId);

            const alamat = await iframe.locator('xpath=//*[@id="f15"]/div[2]/input').inputValue();
            if (!alamat || alamat.trim() === '') {
                sendProgress(sessionId, {
                    status: 'skipped',
                    total: filePaths.length,
                    current: i + 1,
                    fileName: filePaths[i],
                    message: `Skipped file ${i + 1}: alamat is empty`
                });
                results.push({ file: filePaths[i], status: 'skipped', reason: 'Empty alamat' });
                continue;
            }

            await iframe.locator('xpath=//*[@id="f15"]/div[4]/input').fill(resolusi);
            await iframe.locator('xpath=//*[@id="f15"]/div[5]/input').fill(akurasi);
            await iframe.locator('xpath=//*[@id="f15"]/div[6]/input').fill(tahunSurvey);
            await iframe.locator('xpath=//*[@id="f15"]/div[7]/select').selectOption({ index: parseInt(sumberData) });
            await iframe.locator('xpath=//*[@id="f15"]/div[8]/input').fill(nomorHP);

            await checkPauseAndAbort(sessionId);

            await iframe.locator('xpath=//*[@id="mslink2"]').click();
            await iframe.getByText('upload', { exact: true }).click();

            // Report success
            sendProgress(sessionId, {
                status: 'success',
                total: filePaths.length,
                current: i + 1,
                fileName: filePaths[i],
                message: `File ${i + 1} uploaded successfully`
            });
            results.push({ file: filePaths[i], status: 'success' });
        } catch (error) {
            if (error.message === 'Automation aborted by user') {
                results.push({ file: filePaths[i], status: 'aborted' });
                break;
            }
            
            console.log(`Error mengunggah file ${i + 1}:`, error)

            // Report error
            sendProgress(sessionId, {
                status: 'error',
                total: filePaths.length,
                current: i + 1,
                fileName: filePaths[i],
                message: `Error processing file ${i + 1}: ${error.message}`
            });
            results.push({ file: filePaths[i], status: 'error', error: error.message });
        }
    }

    // Cleanup
    delete global.automationStates[sessionId];

    // Send completion
    sendProgress(sessionId, {
        status: 'completed',
        total: filePaths.length,
        current: filePaths.length,
        message: 'All files processed',
        results: results
    });

    return results;
}

// Core automation function for xyztiles
async function processAutomationXyztiles(sessionId, data) {
    const { resolusi, akurasi, tahunSurvey, sumberData, nomorHP, filePaths } = data;

    if (!browser) {
        throw new Error('Browser not initialized. Please login first.');
    }

    // Initialize automation state
    global.automationStates[sessionId] = {
        isPaused: false,
        isAborted: false
    };

    // Send initial progress
    sendProgress(sessionId, {
        status: 'started',
        total: filePaths.length,
        current: 0,
        message: 'Starting automation...',
        sessionId: sessionId
    });

    const results = [];

    for (let i = 0; i < filePaths.length; i++) {
        try {
            // Check pause/abort status
            await checkPauseAndAbort(sessionId);

            // Report start of current file
            sendProgress(sessionId, {
                status: 'processing',
                total: filePaths.length,
                current: i + 1,
                fileName: filePaths[i],
                message: `Processing file ${i + 1} of ${filePaths.length}...`
            });

            const page = browser.pages()[0];
            await page.click('xpath=/html/body/div[1]/aside/div/nav/ul/li[4]/a')

            const iframe = page.frameLocator('iframe')
            const button_xyztiles = iframe.locator('input[value="XYZ DTM"]')
            await button_xyztiles.click()

            await checkPauseAndAbort(sessionId);

            await iframe.locator('input[type="file"]').setInputFiles(filePaths[i]);
            await iframe.getByText(' Registrasi XYZ').click({ timeout: 99999999999 });

            await iframe.waitForSelector('xpath=//*[@id="f15"]/div[4]/input', { timeout: 99999999999 })

            await checkPauseAndAbort(sessionId);

            const alamat = await iframe.locator('xpath=//*[@id="f15"]/div[2]/input').inputValue();
            if (!alamat || alamat.trim() === '') {
                sendProgress(sessionId, {
                    status: 'skipped',
                    total: filePaths.length,
                    current: i + 1,
                    fileName: filePaths[i],
                    message: `Skipped file ${i + 1}: alamat is empty`
                });
                results.push({ file: filePaths[i], status: 'skipped', reason: 'Empty alamat' });
                continue;
            }

            await iframe.locator('xpath=//*[@id="f15"]/div[4]/input').fill(resolusi);
            await iframe.locator('xpath=//*[@id="f15"]/div[5]/input').fill(akurasi);
            await iframe.locator('xpath=//*[@id="f15"]/div[6]/input').fill(tahunSurvey);
            await iframe.locator('xpath=//*[@id="f15"]/div[7]/select').selectOption({ index: parseInt(sumberData) });
            await iframe.locator('xpath=//*[@id="f15"]/div[8]/input').fill(nomorHP);

            await checkPauseAndAbort(sessionId);

            await iframe.locator('xpath=//*[@id="mslink2"]').click();
            await iframe.getByText('upload', { exact: true }).click();

            // Report success
            sendProgress(sessionId, {
                status: 'success',
                total: filePaths.length,
                current: i + 1,
                fileName: filePaths[i],
                message: `File ${i + 1} uploaded successfully`
            });
            results.push({ file: filePaths[i], status: 'success' });
        } catch (error) {
            if (error.message === 'Automation aborted by user') {
                results.push({ file: filePaths[i], status: 'aborted' });
                break;
            }
            
            console.log(`Error mengunggah file ${i + 1}:`, error)

            // Report error
            sendProgress(sessionId, {
                status: 'error',
                total: filePaths.length,
                current: i + 1,
                fileName: filePaths[i],
                message: `Error processing file ${i + 1}: ${error.message}`
            });
            results.push({ file: filePaths[i], status: 'error', error: error.message });
        }
    }

    // Cleanup
    delete global.automationStates[sessionId];

    // Send completion
    sendProgress(sessionId, {
        status: 'completed',
        total: filePaths.length,
        current: filePaths.length,
        message: 'All files processed',
        results: results
    });

    return results;
}

// Queue processor
async function processQueue() {
    if (global.isProcessingQueue || global.automationQueue.length === 0) {
        return;
    }

    global.isProcessingQueue = true;

    while (global.automationQueue.length > 0) {
        const job = global.automationQueue.shift();
        global.currentJob = job;

        try {
            console.log(`Processing job: ${job.sessionId} (${job.type})`);
            
            sendProgress(job.sessionId, {
                status: 'queue_started',
                message: 'Job started from queue'
            });

            let results;
            if (job.type === 'mbtiles') {
                results = await processAutomationMbtiles(job.sessionId, job.data);
            } else if (job.type === 'xyztiles') {
                results = await processAutomationXyztiles(job.sessionId, job.data);
            }

            job.resolve({ success: true, results, sessionId: job.sessionId });
        } catch (error) {
            console.log(`Error processing job ${job.sessionId}:`, error);
            
            sendProgress(job.sessionId, {
                status: 'queue_error',
                message: `Job failed: ${error.message}`
            });

            job.reject(error);
        }

        global.currentJob = null;
    }

    global.isProcessingQueue = false;
}

// Add job to queue
function addToQueue(sessionId, type, data) {
    return new Promise((resolve, reject) => {
        const job = {
            sessionId,
            type,
            data,
            addedAt: new Date().toISOString(),
            resolve,
            reject,
            status: 'queued'
        };

        global.automationQueue.push(job);

        sendProgress(sessionId, {
            status: 'queued',
            position: global.automationQueue.length,
            message: `Added to queue at position ${global.automationQueue.length}`
        });

        console.log(`Job ${sessionId} added to queue. Queue length: ${global.automationQueue.length}`);

        // Start processing queue
        processQueue();
    });
}

app.listen(port, () => {
    console.log(`App listening on port ${port}`)
})

app.post('/login', async (req, res) => {
    try {
        const chromePath = getChromePath();
        const userDataDir = './user-data';

        browser = await chromium.launchPersistentContext(userDataDir, {
            headless: false,
            executablePath: chromePath,
            args: ['--disable-blink-features=AutomationControlled']
        })

        const page = await browser.pages()[0];

        await page.goto('https://petadasar.atrbpn.go.id/');
        await page.click('xpath=/html/body/div[1]/aside/div/nav/ul/li[5]/a');

        // checking udah login/belum
        const loginSuccess = await page.waitForSelector('xpath=/html/body/div[1]/aside/div/nav/ul/li[8]', { timeout: 0 })
        if (loginSuccess) {
            res.send('Login Success')
        } else {
            res.send('Login Failed')
        }
    }
    catch (error) {
        console.log(error);
        res.status(500).send('Login error');
    }
})

app.post('/automation_mbtiles', async (req, res) => {
    const sessionId = req.body.sessionId || `session_${Date.now()}`;
    
    try {
        const { resolusi, akurasi, tahunSurvey, sumberData, nomorHP, filePaths } = req.body;

        if (!browser) {
            return res.status(400).json({
                success: false,
                error: 'Browser not initialized. Please login first.'
            });
        }

        // Add to queue instead of processing immediately
        addToQueue(sessionId, 'mbtiles', { resolusi, akurasi, tahunSurvey, sumberData, nomorHP, filePaths })
            .then(result => {
                // This will be called when the job is completed
                console.log(`Job ${sessionId} completed`);
            })
            .catch(error => {
                console.log(`Job ${sessionId} failed:`, error);
            });

        // Immediately respond that job is queued
        res.json({ 
            success: true, 
            sessionId,
            message: 'Job added to queue',
            queuePosition: global.automationQueue.length
        });
    } catch (error) {
        console.log(error)
        res.status(500).json({ success: false, error: error.message });
    }
})

app.post('/automation_xyztiles', async (req, res) => {
    const sessionId = req.body.sessionId || `session_${Date.now()}`;
    
    try {
        const { resolusi, akurasi, tahunSurvey, sumberData, nomorHP, filePaths } = req.body;

        if (!browser) {
            return res.status(400).json({
                success: false,
                error: 'Browser not initialized. Please login first.'
            });
        }

        // Add to queue instead of processing immediately
        addToQueue(sessionId, 'xyztiles', { resolusi, akurasi, tahunSurvey, sumberData, nomorHP, filePaths })
            .then(result => {
                // This will be called when the job is completed
                console.log(`Job ${sessionId} completed`);
            })
            .catch(error => {
                console.log(`Job ${sessionId} failed:`, error);
            });

        // Immediately respond that job is queued
        res.json({ 
            success: true, 
            sessionId,
            message: 'Job added to queue',
            queuePosition: global.automationQueue.length
        });
    } catch (error) {
        console.log(error)
        res.status(500).json({ success: false, error: error.message });
    }
})