// Import necessary libraries
const path = require('path');
const fs = require('fs');
const pointInPolygon = require('point-in-polygon');
const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
// const rateLimit = require('express-rate-limit'); // Commented out for now
// --- NEW IMPORTS FOR AUTH ---
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = 'your-super-secret-and-long-random-string'; 

// File paths
const zonesGeoJsonPath = path.join(__dirname, 'gcc-divisions-latest.geojson');
const wardZones = require('./ward-zones.json');
const zonesGeoJson = JSON.parse(fs.readFileSync(zonesGeoJsonPath, 'utf8'));

// Service account - IMPORTANT: Replace with your actual file
const serviceAccount = require('./smart-city-network-d7753-firebase-adminsdk-fbsvc-138216b3d0.json');

// Initialize Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const app = express();

// --- CONFIGURATION ---
const CHENNAI_BOUNDS = {
  north: 13.2544,
  south: 12.8345,
  east: 80.3474,
  west: 80.0955
};

const ALLOWED_ISSUE_TYPES = [
  'roads', 'infrastructure', 'utilities', 'waste', 'water', 'other'
];

const ALLOWED_STATUSES = [
  'Open', 'Acknowledged', 'In Progress', 'Resolved', 'Closed'
];


// --- UTILITY FUNCTIONS ---
function findResponsibleDepartment(latitude, longitude, geoJson) {
  const point = [longitude, latitude]; 
  for (const feature of geoJson.features) {
    const polygon = feature.geometry.coordinates[0];
    if (pointInPolygon(point, polygon)) {
      const wardNumber = feature.properties.Name.trim();
      return wardZones[wardNumber] || `Ward ${wardNumber}`;
    }
  }
  return 'Unassigned';
}

function validateCoordinates(lat, lng) {
  return lat >= CHENNAI_BOUNDS.south && lat <= CHENNAI_BOUNDS.north &&
         lng >= CHENNAI_BOUNDS.west && lng <= CHENNAI_BOUNDS.east;
}

function sanitizeInput(input) {
  if (typeof input !== 'string') return '';
  return input.trim().substring(0, 500); // Limit input length
}

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Rate limiting - commented out for now
// const limiter = rateLimit({
//   windowMs: 15 * 60 * 1000, // 15 minutes
//   max: 50, // Limit each IP to 50 requests per windowMs
//   message: { message: "Too many requests, please try again later." }
// });
// app.use('/api/', limiter);

// const submitLimiter = rateLimit({
//   windowMs: 60 * 1000, // 1 minute
//   max: 3, // Max 3 submissions per minute
//   message: { message: "Please wait before submitting another report." }
// });

// --- API ENDPOINTS ---

// Submit a new civic issue report (Create)
const verifyToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (token == null) {
    return res.status(401).json({ success: false, message: 'No token provided' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ success: false, message: 'Invalid token' });
    }
    req.user = user; // Add the user payload (e.g., username) to the request object
    next(); // Proceed to the next function (the actual route handler)
  });
};
app.post('/api/reports', async (req, res) => {
  try {
    const { issue_type, description, latitude, longitude, image_url, title } = req.body;

    // Validation
    if (!issue_type || !latitude || !longitude || !title) {
      return res.status(400).json({ 
        success: false,
        message: "Missing required fields: issue_type, title, latitude, longitude" 
      });
    }

    if (!ALLOWED_ISSUE_TYPES.includes(issue_type)) {
      return res.status(400).json({ 
        success: false,
        message: "Invalid issue type" 
      });
    }

    if (!validateCoordinates(latitude, longitude)) {
      return res.status(400).json({ 
        success: false,
        message: "Coordinates must be within Chennai city limits" 
      });
    }

    const reportData = {
      title: sanitizeInput(title),
      issue_type: issue_type,
      description: sanitizeInput(description),
      status: 'Open',
      boosts: 0,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      location: new admin.firestore.GeoPoint(latitude, longitude),
      image_url: image_url || '',
      assigned_to: findResponsibleDepartment(latitude, longitude, zonesGeoJson),
      assigned_officer: null,
      eta: null,
      reported_by: req.body.user_id || 'anonymous',
      updates: [{
        timestamp: new Date(),
        message: 'Issue reported by citizen',
        type: 'reported',
        updated_by: 'system'
      }]
    };
    
    const docRef = await db.collection('reports').add(reportData);

    res.status(201).json({
      success: true,
      message: 'Report submitted successfully!',
      report_id: docRef.id,
      assigned_ward: reportData.assigned_to
    });

  } catch (error) {
    console.error('Error submitting report:', error);
    res.status(500).json({ 
      success: false,
      message: "Internal server error" 
    });
  }
});

// Get all reports with filtering options (Read)
app.get('/api/reports', async (req, res) => {
  try {
    const { status, ward, issue_type, limit = 50 } = req.query;
    
    let query = db.collection('reports');
    
    // Apply single filter only to avoid index requirements
    if (status) {
      query = query.where('status', '==', status);
    } else if (ward) {
      query = query.where('assigned_to', '==', ward);
    } else if (issue_type) {
      query = query.where('issue_type', '==', issue_type);
    } else {
      // No filters - just order by timestamp
      query = query.orderBy('timestamp', 'desc');
    }
    
    query = query.limit(parseInt(limit));
    
    const snapshot = await query.get();
    
    const reports = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      reports.push({
        id: doc.id,
        title: data.title,
        issue_type: data.issue_type,
        status: data.status,
        description: data.description,
        latitude: data.location.latitude,
        longitude: data.location.longitude,
        timestamp: data.timestamp ? data.timestamp.toDate() : null,
        image_url: data.image_url,
        boosts: data.boosts || 0,
        assigned_to: data.assigned_to,
        assigned_officer: data.assigned_officer,
        eta: data.eta
      });
    });

    res.status(200).json({
      success: true,
      reports,
      count: reports.length
    });

  } catch (error) {
    console.error('Error getting reports:', error);
    res.status(500).json({ 
      success: false,
      message: "Error retrieving reports" 
    });
  }
});

// Get specific report with full details including updates
app.get('/api/reports/:id', async (req, res) => {
  try {
    const reportId = req.params.id;
    const reportDoc = await db.collection('reports').doc(reportId).get();
    
    if (!reportDoc.exists) {
      return res.status(404).json({ 
        success: false,
        message: "Report not found" 
      });
    }

    const data = reportDoc.data();
    const report = {
      id: reportDoc.id,
      title: data.title,
      issue_type: data.issue_type,
      status: data.status,
      description: data.description,
      latitude: data.location.latitude,
      longitude: data.location.longitude,
      timestamp: data.timestamp ? data.timestamp.toDate() : null,
      image_url: data.image_url,
      boosts: data.boosts || 0,
      assigned_to: data.assigned_to,
      assigned_officer: data.assigned_officer,
      eta: data.eta,
      updates: data.updates || []
    };

    res.status(200).json({
      success: true,
      report
    });

  } catch (error) {
    console.error('Error getting report:', error);
    res.status(500).json({ 
      success: false,
      message: "Error retrieving report" 
    });
  }
});

// Boost/vote for an issue
app.post('/api/reports/:id/boost', async (req, res) => {
  try {
    const reportId = req.params.id;
    const { user_id } = req.body;

    // Check if report exists
    const reportRef = db.collection('reports').doc(reportId);
    const reportDoc = await reportRef.get();
    
    if (!reportDoc.exists) {
      return res.status(404).json({ 
        success: false,
        message: "Report not found" 
      });
    }

    // TODO: Implement logic to prevent duplicate votes by same user
    // You can create a subcollection 'boosts' to track who voted
    
    await reportRef.update({
      boosts: admin.firestore.FieldValue.increment(1)
    });

    res.status(200).json({
      success: true,
      message: "Issue boosted successfully"
    });

  } catch (error) {
    console.error('Error boosting report:', error);
    res.status(500).json({ 
      success: false,
      message: "Error boosting report" 
    });
  }
});

// Update report status (for government officials)
app.put('/api/reports/:id/status', async (req, res) => {
  try {
    const reportId = req.params.id;
    const { status, officer_name, eta, update_message, updated_by } = req.body;
    
    if (!status || !ALLOWED_STATUSES.includes(status)) {
      return res.status(400).json({ 
        success: false,
        message: "Invalid or missing status" 
      });
    }

    const reportRef = db.collection('reports').doc(reportId);
    const reportDoc = await reportRef.get();
    
    if (!reportDoc.exists) {
      return res.status(404).json({ 
        success: false,
        message: "Report not found" 
      });
    }

    const updateData = {
      status: status,
      last_updated: admin.firestore.FieldValue.serverTimestamp()
    };

    // Add officer assignment if provided
    if (officer_name) updateData.assigned_officer = officer_name;
    if (eta) updateData.eta = eta;

    // Add to updates array
    const newUpdate = {
      timestamp: new Date(),
      message: update_message || `Status changed to ${status}`,
      type: status.toLowerCase().replace(' ', '_'),
      updated_by: updated_by || 'system'
    };

    updateData.updates = admin.firestore.FieldValue.arrayUnion(newUpdate);

    await reportRef.update(updateData);

    res.status(200).json({
      success: true,
      message: `Report status updated to: ${status}`
    });

  } catch (error) {
    console.error('Error updating report status:', error);
    res.status(500).json({ 
      success: false,
      message: "Error updating report status" 
    });
  }
});

// Get reports by ward (for government dashboards)
app.get('/api/reports/ward/:wardName', async (req, res) => {
  try {
    const { wardName } = req.params;
    const { status, limit = 100 } = req.query;

    let query = db.collection('reports')
      .where('assigned_to', '==', wardName)
      .orderBy('boosts', 'desc')
      .orderBy('timestamp', 'desc');

    if (status) {
      query = query.where('status', '==', status);
    }

    query = query.limit(parseInt(limit));
    const snapshot = await query.get();
    
    const reports = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      reports.push({
        id: doc.id,
        title: data.title,
        issue_type: data.issue_type,
        status: data.status,
        description: data.description,
        latitude: data.location.latitude,
        longitude: data.location.longitude,
        timestamp: data.timestamp ? data.timestamp.toDate() : null,
        boosts: data.boosts || 0,
        assigned_officer: data.assigned_officer,
        eta: data.eta
      });
    });

    res.status(200).json({
      success: true,
      ward: wardName,
      reports,
      count: reports.length
    });

  } catch (error) {
    console.error('Error getting ward reports:', error);
    res.status(500).json({ 
      success: false,
      message: "Error retrieving ward reports" 
    });
  }
});

// Get analytics/statistics
app.get('/api/analytics', async (req, res) => {
  try {
    const { ward } = req.query;
    
    let baseQuery = db.collection('reports');
    if (ward) baseQuery = baseQuery.where('assigned_to', '==', ward);

    const snapshot = await baseQuery.get();
    
    const analytics = {
      total_reports: 0,
      by_status: {},
      by_type: {},
      by_ward: {},
      avg_boosts: 0,
      total_boosts: 0
    };

    let totalBoosts = 0;
    snapshot.forEach(doc => {
      const data = doc.data();
      analytics.total_reports++;
      
      // Count by status
      analytics.by_status[data.status] = (analytics.by_status[data.status] || 0) + 1;
      
      // Count by type
      analytics.by_type[data.issue_type] = (analytics.by_type[data.issue_type] || 0) + 1;
      
      // Count by ward
      analytics.by_ward[data.assigned_to] = (analytics.by_ward[data.assigned_to] || 0) + 1;
      
      // Sum boosts
      totalBoosts += data.boosts || 0;
    });

    analytics.total_boosts = totalBoosts;
    analytics.avg_boosts = analytics.total_reports > 0 ? 
      (totalBoosts / analytics.total_reports).toFixed(2) : 0;

    res.status(200).json({
      success: true,
      analytics
    });

  } catch (error) {
    console.error('Error getting analytics:', error);
    res.status(500).json({ 
      success: false,
      message: "Error retrieving analytics" 
    });
  }
});

// Delete a report (admin only - add authentication later)
app.delete('/api/reports/:id', async (req, res) => {
  try {
    const reportId = req.params.id;
    
    const reportRef = db.collection('reports').doc(reportId);
    const reportDoc = await reportRef.get();
    
    if (!reportDoc.exists) {
      return res.status(404).json({ 
        success: false,
        message: "Report not found" 
      });
    }

    await reportRef.delete();

    res.status(200).json({
      success: true,
      message: "Report deleted successfully"
    });

  } catch (error) {
    console.error('Error deleting report:', error);
    res.status(500).json({ 
      success: false,
      message: "Error deleting report" 
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: "Chennai Civic Network API is running",
    timestamp: new Date().toISOString(),
    version: "1.0.0"
  });
});

// Get all wards/zones
app.get('/api/wards', (req, res) => {
  try {
    const wards = Object.values(wardZones);
    const uniqueWards = [...new Set(wards)];
    
    res.status(200).json({
      success: true,
      wards: uniqueWards.sort()
    });
  } catch (error) {
    res.status(500).json({ 
      success: false,
      message: "Error retrieving wards" 
    });
  }
});

// --- ERROR HANDLING ---
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    message: "Internal server error"
  });
});

// Handle 404 for undefined routes
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found"
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Chennai Civic Network API running on port ${PORT}`);
  console.log(`📍 Monitoring ${Object.keys(wardZones).length} Chennai wards`);
  console.log(`🔗 Health check: http://localhost:${PORT}/api/health`);
});