// index.js
const express = require("express");
const app = express();

app.get("/health", (req, res) => {
    console.log("Health check endpoint called");
  res.json({ status: "UP", time: new Date() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server started on port " + PORT);
});