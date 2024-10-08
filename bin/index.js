#!/usr/local/bin/node
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os')
const { program } = require("commander")

const app = express();
const port = 3000;

const tileServerUrl = 'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png';

const getZoomLevel = (zoomTitle) => {
    const zoomLevels = {
        station: 12,
        region: 10,
        country: 8
    };
    return zoomLevels[zoomTitle] || 0;
};

const latLonToTile = (lat, lon, zoom) => {
    const latRad = (lat * Math.PI) / 180;
    const n = Math.pow(2, zoom);
    const x = Math.floor((lon + 180) / 360 * n);
    const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
    return { x, y };
};

program
    .version("1.0.0")
    .description("My Node CLI")
    .requiredOption("-p, --path <directory>", "Path to cache folder")
    .action((options) => {
        const getCacheDirectory = (zoomTitle) => {
            const cacheDir = path.join(options.path, zoomTitle);
            if (!fs.existsSync(cacheDir)) {
                fs.mkdirSync(cacheDir, { recursive: true });
            }
            return cacheDir;
        };

        const getCacheFilePath = (zoomTitle, x, y) => {
            const cacheDir = getCacheDirectory(zoomTitle);
            return path.join(cacheDir, `${zoomTitle}_${x}_${y}.png`);
        };

        app.get('/prerender/:zoomTitle/:lat1/:lon1/:lat2/:lon2', async (req, res) => {
            const zoomTitle = req.params.zoomTitle;
            const zoomLevel = getZoomLevel(zoomTitle);

            if (zoomLevel === 0) {
                return res.status(404).send('Invalid zoom type...');
            }

            const lat1 = parseFloat(req.params.lat1);
            const lon1 = parseFloat(req.params.lon1);
            const lat2 = parseFloat(req.params.lat2);
            const lon2 = parseFloat(req.params.lon2);

            const { x: xStart, y: yStart } = latLonToTile(lat1, lon1, zoomLevel);
            const { x: xEnd, y: yEnd } = latLonToTile(lat2, lon2, zoomLevel);

            const totalTiles = (xEnd - xStart + 1) * (yEnd - yStart + 1);
            let processedTiles = 0;
            const startTime = Date.now();

            res.set('Content-Type', 'application/json');

            for (let x = xStart; x <= xEnd; x++) {
                for (let y = yStart; y <= yEnd; y++) {
                    const tileStartTime = Date.now();
                    const cacheFilePath = getCacheFilePath(zoomTitle, x, y);

                    try {
                        const url = tileServerUrl.replace('{z}', zoomLevel).replace('{x}', x).replace('{y}', y);
                        const response = await axios.get(url, { responseType: 'arraybuffer' });
                        await fs.writeFileSync(cacheFilePath, response.data);
                    } catch (error) {
                        console.error(`Failed to fetch tile at ${x}, ${y}:`, error);
                        continue;
                    }

                    processedTiles++;
                    const tileEndTime = Date.now();
                    const timePerTile = ((tileEndTime - tileStartTime) / 1000).toFixed(2);
                    const progress = ((processedTiles / totalTiles) * 100).toFixed(2);
                    res.write(JSON.stringify({
                        status: 'progress',
                        progress: `${progress}%`,
                        currentTile: { x, y },
                        remainingTiles: totalTiles - processedTiles,
                        timePerTile: `${timePerTile} seconds`
                    }) + '\n');
                }
            }

            const endTime = Date.now();
            const totalTime = ((endTime - startTime) / 1000).toFixed(2);
            const avgTimePerTile = (totalTime / processedTiles).toFixed(2);

            res.write(JSON.stringify({
                status: 'complete',
                totalTiles,
                processedTiles,
                totalTime: `${totalTime} seconds`,
                avgTimePerTile: `${avgTimePerTile} seconds`
            }));
            res.end();
        });

        app.use('/cache', express.static(program.opts().path));

        app.get('/', (req, res) => {
            const htmlContent = `
                <!DOCTYPE html>
                <html lang="en">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Atlas Map Render</title>
                    <link rel="stylesheet" href="https://unpkg.com/leaflet/dist/leaflet.css" />
                    <link href="https://fonts.googleapis.com/css2?family=Red+Hat+Display:wght@400;700&display=swap" rel="stylesheet">
                    <style>
                        html, body {
                            height: 100%; 
                            margin: 0;   
                            padding: 0;  
                        }
                        #map {
                            height: 100%; 
                            width: 100%; 
                        }
                        .leaflet-control-attribution {
                            font-family: 'Red Hat Display', sans-serif;
                        }
                        #version-info {
                            position: absolute;
                            bottom: 10px;
                            left: 10px;
                            font-family: 'Red Hat Display', sans-serif;
                            font-size: 12px; 
                            font-weight: bold; 
                            color: #555; 
                            background: rgba(255, 255, 255, 0.7);
                            padding: 5px;
                            border-radius: 5px;
                            z-index: 1000; 
                        }
                    </style>
                    <meta name="apple-mobile-web-app-capable" content="yes">
                    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
                </head>
                <body>
                    <div id="map"></div>
                    <div id="version-info">0.1.0</div>
                    <script src="https://unpkg.com/leaflet/dist/leaflet.js"></script>
                    <script>
                        const map = L.map('map', {
                            scrollWheelZoom: false 
                        }).setView([54.0, -2.0], 10);
        
                        const getZoomTitle = (zoom) => {
                            if (zoom >= 12) return 'station';
                            if (zoom >= 10) return 'region';
                            if (zoom >= 8) return 'country';
                            return null;
                        };
                        
                        const initialZoomTitle = getZoomTitle(map.getZoom());
                        const tileLayer = L.tileLayer("/cache/" + initialZoomTitle + '/' + initialZoomTitle + '_{x}_{y}.png', {
                            maxZoom: 12,
                            minZoom: 8,
                            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
                        }).addTo(map);
        
                        const setZoomIncrements = (increment) => {
                            let newZoom = map.getZoom() + increment;
                            newZoom = Math.max(8, Math.min(newZoom, 12));
                            map.setZoom(newZoom);
                        };
        
                        map.getContainer().addEventListener('wheel', (event) => {
                            event.preventDefault(); 
                            const delta = event.deltaY < 0 ? 2 : -2; 
                            setZoomIncrements(delta); 
                        });
        
                        map.on('zoomend', () => {
                            const zoom = map.getZoom();
                            const zoomTitle = getZoomTitle(zoom);
                            tileLayer.setUrl("/cache/" + zoomTitle + '/' + zoomTitle + '_{x}_{y}.png');
                        });
                    </script>
                </body>
                </html>
            `;
            res.send(htmlContent);
        });

        app.listen(port, () => {
            console.log(`Atlas Map Processor is running on http://localhost:${port}`);
        });
});
program.parse(process.argv);

