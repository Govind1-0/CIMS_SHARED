
const express = require("express");
const router  = express.Router();
const bwipjs  = require("bwip-js");
const axios   = require("axios");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

router.get("/generate/:code", async (req, res) => {
  const { code } = req.params;
  const type = req.query.type || "code128"; 

  try {
    const png = await bwipjs.toBuffer({
      bcid:        type,
      text:        code,
      scale:       3,
      height:      12,
      includetext: true,
      textxalign:  "center",
      textsize:    10,
    });

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(png);

  } catch (err) {
    console.error("Barcode generation error:", err.message);
    res.status(500).json({ success: false, message: "Failed to generate barcode" });
  }
});

router.get("/lookup/:barcode", async (req, res) => {
  const { barcode } = req.params;

  const { data: localProduct } = await supabase
    .from("products")
    .select("*")
    .eq("barcode", barcode)
    .single();

  if (localProduct) {
    return res.status(200).json({
      success: true,
      source:  "cims",
      message: "Found in your CIMS database",
      product: localProduct,
    });
  }

  try {
    const external = await axios.get(
      `https://api.upcitemdb.com/prod/trial/lookup?upc=${barcode}`,
      { timeout: 5000 }
    );

    const item = external.data?.items?.[0];

    if (item) {
      return res.status(200).json({
        success:  true,
        source:   "external",
        message:  "Found online — review and save to CIMS",
        product: {
          name:           item.title        || "",
          description:    item.description  || "",
          origin_country: item.brand        || "",
          category:       item.category     || "",
          barcode:        barcode,
          sku:            item.model        || "",
          image_url:      item.images?.[0]  || "",
          unit_price:     item.lowest_recorded_price || 0,
        },
      });
    }

  } catch (err) {
    console.log("External lookup failed:", err.message);
  }

  return res.status(404).json({
    success: false,
    source:  "none",
    message: "Product not found. Register it as a new product.",
    barcode,
  });
});

router.get("/all", async (req, res) => {
  try {
    const { data: products, error } = await supabase
      .from("products")
      .select("id, name, barcode, sku")
      .not("barcode", "is", null)
      .order("created_at", { ascending: false });

    if (error) throw error;

    const withBarcodes = products.map(p => ({
      ...p,
      barcode_image_url: `https://cims-backends.onrender.com/api/barcode/generate/${encodeURIComponent(p.barcode)}`,
    }));

    return res.status(200).json({
      success:  true,
      total:    products.length,
      products: withBarcodes,
    });

  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;