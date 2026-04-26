require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const axios = require("axios");
const cors = require("cors");

const app = express();


app.use(cors({
  origin: [
    "http://localhost:3000",
    "https://med-backend-r8bj.onrender.com" // later for prod
  ],
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: true
}));

// Create DB pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // required for Neon
  },
});

const sampleHospitals = [];

// Free alternative: OpenStreetMap Overpass API integration
const searchOpenStreetMapHospitals = async (specialization, lat, lng, page = 1, limit = 10) => {
  try {
    const offset = (page - 1) * limit;
    // Very simple Overpass API query - just search for hospitals/clinics/doctors
    const query = `
      [out:json][timeout:20];
      (
        node["amenity"~"hospital|clinic|doctors"](around:75000,${lat},${lng});
        way["amenity"~"hospital|clinic|doctors"](around:75000,${lat},${lng});
        relation["amenity"~"hospital|clinic|doctors"](around:75000,${lat},${lng});
      );
      out center meta;
    `;

    console.log("OpenStreetMap query for coords:", lat, lng);
    // Try multiple Overpass API endpoints in case one is down
    const endpoints = [
      'https://overpass.openstreetmap.fr/api/interpreter',
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
      'https://overpass.osm.rambler.ru/cgi/interpreter'
    ];

    let response;
    for (const endpoint of endpoints) {
      try {
        console.log(`Trying endpoint: ${endpoint}`);
        response = await axios.get(endpoint, {
          params: {
            data: query.trim(),
            _cache_bust: Date.now() // Add cache busting
          },
          timeout: 12000, // Reduced timeout
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'HospitalSearchApp/1.0'
          }
        });
        console.log(`Success with endpoint: ${endpoint}`);
        break; // If successful, break out of loop
      } catch (error) {
        console.log(`Endpoint ${endpoint} failed:`, error.message);
        if (endpoint === endpoints[endpoints.length - 1]) {
          throw error; // If all endpoints failed, throw the last error
        }
      }
    }

    console.log("OpenStreetMap raw response elements:", response.data.elements?.length || 0);

    if (!response.data.elements || response.data.elements.length === 0) {
      console.log("No elements found in OpenStreetMap response");
      throw new Error("No hospital data found");
    }

    // Process and filter results
    const hospitals = response.data.elements
      .filter(element => element.tags && element.tags.name) // Only facilities with names
      .slice(0, 50) // Get more results initially (increased from 20)
      .map((element, index) => {
        const elementLat = element.lat || (element.center && element.center.lat);
        const elementLng = element.lon || (element.center && element.center.lon);

        // Determine specialization based on amenity type and available data
        let detectedSpecialization = 'General Medicine'; // Default

        if (element.tags.amenity === 'hospital') {
          detectedSpecialization = element.tags.specialty || element.tags['healthcare:speciality'] || 'General Medicine';
        } else if (element.tags.amenity === 'clinic') {
          detectedSpecialization = element.tags.specialty || element.tags['healthcare:speciality'] || 'General Practice';
        } else if (element.tags.amenity === 'doctors') {
          detectedSpecialization = element.tags.specialty || element.tags['healthcare:speciality'] || 'General Practice';
        } else if (element.tags.amenity === 'dentist') {
          detectedSpecialization = 'Dentistry';
        } else if (element.tags.amenity === 'pharmacy') {
          detectedSpecialization = 'Pharmacy';
        } else if (element.tags.healthcare) {
          detectedSpecialization = element.tags['healthcare:speciality'] || element.tags.specialty || 'General Medicine';
        }

        // If no specific specialization found and user requested one, use that as fallback
        if (detectedSpecialization === 'General Medicine' && specialization) {
          detectedSpecialization = specialization;
        }

        return {
          id: element.id || `osm_${index}`,
          name: element.tags.name,
          address: element.tags['addr:full'] ||
                   `${element.tags['addr:street'] || ''} ${element.tags['addr:housenumber'] || ''}, ${element.tags['addr:city'] || 'India'}`.trim() ||
                   'Address not available',
          city: element.tags['addr:city'] || element.tags['addr:district'] || element.tags['addr:state'] || 'India',
          specialization: detectedSpecialization,
          phone: element.tags.phone || element.tags['contact:phone'] || null,
          rating: null, // OpenStreetMap doesn't have ratings
          distance: elementLat && elementLng ? calculateDistance(lat, lng, elementLat, elementLng) : null
          // Removed source field as requested
        };
      })
      .filter(hospital => hospital.distance !== null && hospital.distance <= 75) // Match the 75km query radius
      .sort((a, b) => (a.distance || 999) - (b.distance || 999)) // Sort by distance
      .slice(0, 25); // Return top 25 closest (increased from 10)

    console.log("Filtered hospitals:", hospitals.map(h => ({ name: h.name, distance: h.distance?.toFixed(1), city: h.city, specialization: h.specialization })));

    // Apply specialization filtering if specified
    let filteredHospitals = hospitals;
    if (specialization) {
      filteredHospitals = hospitals.filter(hospital =>
        hospital.specialization.toLowerCase().includes(specialization.toLowerCase())
      );
    }

    // Apply pagination
    const total = filteredHospitals.length;
    const paginatedResults = filteredHospitals.slice(offset, offset + limit);

    return {
      data: paginatedResults,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNext: page * limit < total,
        hasPrev: page > 1
      }
    };
  } catch (error) {
    console.error("OpenStreetMap API error:", error.message);
    throw error;
  }
};

// Calculate distance between two points using Haversine formula
const calculateDistance = (lat1, lng1, lat2, lng2) => {
  const R = 6371; // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng/2) * Math.sin(dLng/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c; // Distance in kilometers
};

// Simple city detection based on coordinates
const getCityFromCoordinates = (lat, lng) => {
  // Major Indian cities coordinates
  const cities = {
    "Mumbai": { lat: 19.0760, lng: 72.8777 },
    "Delhi": { lat: 28.7041, lng: 77.1025 },
    "Bangalore": { lat: 12.9716, lng: 77.5946 },
    "Chennai": { lat: 13.0827, lng: 80.2707 },
    "Kolkata": { lat: 22.5726, lng: 88.3639 },
    "Pune": { lat: 18.5204, lng: 73.8567 },
    "Hyderabad": { lat: 17.3850, lng: 78.4867 },
    "Ahmedabad": { lat: 23.0225, lng: 72.5714 },
  };

  let closestCity = "Bangalore"; // Default fallback
  let minDistance = Infinity;

  for (const [cityName, coords] of Object.entries(cities)) {
    const distance = calculateDistance(lat, lng, coords.lat, coords.lng);
    if (distance < minDistance) {
      minDistance = distance;
      closestCity = cityName;
    }
  }

  // If within 50km of a city, return that city
  return minDistance < 50 ? closestCity : "Bangalore";
};

// Test DB connection
app.get("/db-test", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({
      status: "DB Connected",
      time: result.rows[0],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "DB connection failed" });
  }
});

// Existing health API
app.get("/health", (req, res) => {
  console.log("Health check endpoint called");
  res.json({ status: "UP", time: new Date() });
});

app.get("/users", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM public.users");

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      message: "Error fetching users",
    });
  }
});


app.get("/tables", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_type = 'BASE TABLE'
      ORDER BY table_schema, table_name;
    `);

    res.json({
      success: true,
      tables: result.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      message: "Error fetching tables",
    });
  }
});

app.get("/api/hospitals", async (req, res) => {
  const specialization = req.query.specialization || "";
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10; // Default 10 per page
  const offset = (page - 1) * limit;

  console.log("Hospital search request:", { specialization, lat, lng, page, limit });

  if (!lat || !lng || isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({
      success: false,
      message: "Valid latitude and longitude are required",
    });
  }

  // Try OpenStreetMap API (only data source now)
  try {
    console.log("Trying OpenStreetMap API for coordinates:", lat, lng);
    const result = await searchOpenStreetMapHospitals(specialization, lat, lng, page, limit);
    console.log("OpenStreetMap returned", result.data.length, "hospitals");

    return res.json({
      success: true,
      data: result.data,
      pagination: result.pagination
      // Removed source field as requested
    });
  } catch (error) {
    console.log("OpenStreetMap API failed:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to fetch hospital data. Please try again later.",
      error: error.message
    });
  }
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log("Server started on port " + PORT);
});

