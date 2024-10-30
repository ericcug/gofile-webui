const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs').promises;
const axios = require('axios');
const crypto = require('crypto');
const { createWriteStream, existsSync, statSync } = require('fs');
const { mkdir, rmdir } = require('fs').promises;
const readline = require('readline');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

function log(message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
    return `[${timestamp}] ${message}`;
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/download', async (req, res) => {
    const urls = req.body.urls.filter(url => url.trim().startsWith('http'));

    if (urls.length === 0) {
        return res.status(400).send('No valid URLs provided');
    }

    const downloadDir = '/downloads';

    class GoFileDownloader {
        constructor(url, password = null, maxWorkers = 5) {
            this.rootDir = process.env.GF_DOWNLOADDIR || process.cwd();
            this.maxWorkers = maxWorkers;
            this.token = process.env.GF_TOKEN;
            this.message = ' ';
            this.contentDir = null;
            this.recursiveFilesIndex = 0;
            this.filesInfo = {};
            this.activeDownloads = 0;

            this.init(url, password);
        }

        async init(url, password) {
            if (!this.token) {
                this.token = await this.getToken();
            }
            await this.parseUrlOrFile(url, password);
        }

        async getToken() {
            const userAgent = process.env.GF_USERAGENT || 'Mozilla/5.0';
            const headers = {
                'User-Agent': userAgent,
                'Accept-Encoding': 'gzip, deflate, br',
                'Accept': '*/*',
                'Connection': 'keep-alive'
            };

            try {
                const response = await axios.post('https://api.gofile.io/accounts', {}, { headers });
                if (response.data.status !== 'ok') {
                    throw new Error('Account creation failed!');
                }
                return response.data.data.token;
            } catch (error) {
                throw new Error(`Failed to create account: ${error.message}`);
            }
        }

        async createDir(dirname) {
            const filepath = path.join(process.cwd(), dirname);
            try {
                await mkdir(filepath);
            } catch (error) {
                if (error.code !== 'EEXIST') {
                    throw error;
                }
            }
        }

        async downloadContent(fileInfo) {
            const filepath = path.join(fileInfo.path, fileInfo.filename);
            if (existsSync(filepath) && statSync(filepath).size > 0) {
                log(`${filepath} already exists, skipping.`);
                return;
            }

            const tmpFile = `${filepath}.part`;
            const url = fileInfo.link;
            const userAgent = process.env.GF_USERAGENT || 'Mozilla/5.0';

            const headers = {
                'Cookie': `accountToken=${this.token}`,
                'Accept-Encoding': 'gzip, deflate, br',
                'User-Agent': userAgent,
                'Accept': '*/*',
                'Referer': `${url}${url.endsWith('/') ? '' : '/'}`,
                'Origin': url,
                'Connection': 'keep-alive',
                'Sec-Fetch-Dest': 'empty',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Site': 'same-site',
                'Pragma': 'no-cache',
                'Cache-Control': 'no-cache'
            };

            let partSize = 0;
            if (existsSync(tmpFile)) {
                partSize = statSync(tmpFile).size;
                headers['Range'] = `bytes=${partSize}-`;
            }

            try {
                const response = await axios({
                    method: 'get',
                    url,
                    headers,
                    responseType: 'stream',
                    timeout: 27000
                });

                const totalSize = parseInt(response.headers['content-length'], 10);
                if (!totalSize) {
                    log(`Couldn't find the file size from ${url}.`);
                    return;
                }

                const writer = createWriteStream(tmpFile, { flags: 'a' });
                const startTime = process.hrtime();

                response.data.on('data', (chunk) => {
                    const progress = ((partSize + writer.bytesWritten) / totalSize) * 100;
                    const [seconds, nanoseconds] = process.hrtime(startTime);
                    const rate = writer.bytesWritten / (seconds + nanoseconds / 1e9);
                    
                    let displayRate = rate;
                    let unit = 'B/s';
                    
                    if (rate >= 1024 * 1024 * 1024) {
                        displayRate = rate / (1024 * 1024 * 1024);
                        unit = 'GB/s';
                    } else if (rate >= 1024 * 1024) {
                        displayRate = rate / (1024 * 1024);
                        unit = 'MB/s';
                    } else if (rate >= 1024) {
                        displayRate = rate / 1024;
                        unit = 'KB/s';
                    }

                    this.message = `\rDownloading ${fileInfo.filename}: ${partSize + writer.bytesWritten} of ${totalSize} ${progress.toFixed(1)}% ${displayRate.toFixed(1)}${unit}`;
                    log(this.message);
                });

                await new Promise((resolve, reject) => {
                    writer.on('finish', resolve);
                    writer.on('error', reject);
                    response.data.pipe(writer);
                });

                if (statSync(tmpFile).size === totalSize) {
                    log(`\rDownloading ${fileInfo.filename}: ${totalSize} of ${totalSize} Done!`);
                    await fs.rename(tmpFile, filepath);
                }
            } catch (error) {
                log(`Error downloading ${fileInfo.filename}: ${error.message}`);
                throw error;
            }
        }

        async parseLinksRecursively(contentId, password = null) {
            const url = `https://api.gofile.io/contents/${contentId}?wt=4fd6sg89d7s6&cache=true${password ? `&password=${password}` : ''}`;
            const userAgent = process.env.GF_USERAGENT || 'Mozilla/5.0';

            const headers = {
                'User-Agent': userAgent,
                'Accept-Encoding': 'gzip, deflate, br',
                'Accept': '*/*',
                'Connection': 'keep-alive',
                'Authorization': `Bearer ${this.token}`
            };

            try {
                const response = await axios.get(url, { headers });
                const { data } = response.data;

                if (response.data.status !== 'ok') {
                    log(`Failed to get a link as response from ${url}.`);
                    return;
                }

                if (data.password && data.passwordStatus !== 'passwordOk') {
                    log(`Password protected link. Please provide the password.`);
                    return;
                }

                if (data.type === 'folder') {
                    if (!this.contentDir && data.name !== contentId) {
                        this.contentDir = path.join(this.rootDir, contentId);
                        await this.createDir(contentId);
                        process.chdir(this.contentDir);
                    } else if (!this.contentDir && data.name === contentId) {
                        this.contentDir = path.join(this.rootDir, contentId);
                        await this.createDir(contentId);
                    }

                    await this.createDir(data.name);
                    process.chdir(data.name);

                    for (const childId in data.children) {
                        const child = data.children[childId];
                        if (child.type === 'folder') {
                            await this.parseLinksRecursively(child.id, password);
                        } else {
                            this.recursiveFilesIndex++;
                            this.filesInfo[this.recursiveFilesIndex.toString()] = {
                                path: process.cwd(),
                                filename: child.name,
                                link: child.link
                            };
                        }
                    }

                    process.chdir('..');
                } else {
                    this.recursiveFilesIndex++;
                    this.filesInfo[this.recursiveFilesIndex.toString()] = {
                        path: process.cwd(),
                        filename: data.name,
                        link: data.link
                    };
                }
            } catch (error) {
                log(`Error parsing links: ${error.message}`);
                throw error;
            }
        }

        async threadedDownloads() {
            if (!this.contentDir) {
                log(`Content directory wasn't created, nothing done.`);
                return;
            }

            process.chdir(this.contentDir);

            const downloads = Object.values(this.filesInfo).map(fileInfo => 
                this.downloadContent(fileInfo)
            );

            await Promise.all(downloads);
            process.chdir(this.rootDir);
        }

        printListFiles() {
            const MAX_FILENAME_CHARACTERS = 100;
            const width = Math.max(...Object.keys(this.filesInfo).map(k => `[${k}] -> `.length));

            for (const [k, v] of Object.entries(this.filesInfo)) {
                const filepath = path.join(v.path, v.filename);
                const displayPath = filepath.length > MAX_FILENAME_CHARACTERS
                    ? `...${filepath.slice(-MAX_FILENAME_CHARACTERS)}`
                    : filepath;

                const text = `${`[${k}] -> `.padEnd(width)}${displayPath}`;
                log(`${text}${NEW_LINE}${'-'.repeat(text.length)}`);
            }
        }

        async download(url, password = null) {
            try {
                const urlParts = url.split('/');
                if (urlParts[urlParts.length - 2] !== 'd') {
                    log(`The url probably doesn't have an id in it: ${url}.`);
                    return;
                }

                const contentId = urlParts[urlParts.length - 1];
                const hashedPassword = password
                    ? crypto.createHash('sha256').update(password).digest('hex')
                    : null;

                await this.parseLinksRecursively(contentId, hashedPassword);

                if (!this.contentDir) {
                    log(`No content directory created for url: ${url}, nothing done.`);
                    this.resetClassProperties();
                    return;
                }

                const dirContents = await fs.readdir(this.contentDir);
                if (dirContents.length === 0 && Object.keys(this.filesInfo).length === 0) {
                    log(`Empty directory for url: ${url}, nothing done.`);
                    await rmdir(this.contentDir);
                    this.resetClassProperties();
                    return;
                }

                const interactive = process.env.GF_INTERACTIVE === '1';

                if (interactive) {
                    this.printListFiles();

                    const rl = readline.createInterface({
                        input: process.stdin,
                        output: process.stdout
                    });

                    const answer = await new Promise(resolve => {
                        rl.question(`Files to download (Ex: 1 3 7 | or leave empty to download them all):: `, resolve);
                    });
                    rl.close();

                    const inputList = answer.split(' ').filter(k => this.filesInfo[k]);

                    if (inputList.length === 0) {
                        log(`Nothing done.`);
                        await rmdir(this.contentDir);
                        this.resetClassProperties();
                        return;
                    }

                    const keysToDelete = Object.keys(this.filesInfo).filter(k => !inputList.includes(k));
                    keysToDelete.forEach(key => delete this.filesInfo[key]);
                }

                await this.threadedDownloads();
                this.resetClassProperties();
            } catch (error) {
                log(`Error during download: ${error.message}`);
                throw error;
            }
        }

        async parseUrlOrFile(urlOrFile, password = null) {
            try {
                const stats = await fs.stat(urlOrFile);
                if (stats.isFile()) {
                    const content = await fs.readFile(urlOrFile, 'utf8');
                    const lines = content.split('\n');
                    
                    for (const line of lines) {
                        const [url, linePassword] = line.trim().split(' ');
                        await this.download(url, password || linePassword || null);
                    }
                } else {
                    await this.download(urlOrFile, password);
                }
            } catch (error) {
                if (error.code === 'ENOENT') {
                    await this.download(urlOrFile, password);
                } else {
                    log(`Error parsing url or file: ${error.message}`);
                    throw error;
                }
            }
        }

        resetClassProperties() {
            this.message = ' ';
            this.contentDir = null;
            this.recursiveFilesIndex = 0;
            this.filesInfo = {};
        }
    }

    try {
        for (const url of urls) {
            await new GoFileDownloader(url);
        }
        res.send('Download started');
    } catch (error) {
        res.status(500).send(`Download failed: ${error.message}`);
    }
});

server.listen(PORT, () => {
    log(`Server is running on http://localhost:${PORT}`);
});
