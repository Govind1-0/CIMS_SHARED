const express = require("express");
const router = express.Router();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const { requireAuth } = require("../middleware/auth");
router.use(requireAuth);

// Hotel staff can only touch their own hotel.
// (Express 5: req.body is undefined on GET requests, and req.params is not
//  filled in at router level - so check the :hotel_id param and the body safely.)
router.param("hotel_id", (req, res, next, value) => {
  if (req.user.role === "hotel_staff" && value !== req.user.hotel_id) {
    return res.status(403).json({ success: false, message: "Access denied." });
  }
  next();
});

router.use((req, res, next) => {
  const hotel_id = req.body?.hotel_id;

  if (req.user.role === "hotel_staff" && hotel_id && hotel_id !== req.user.hotel_id) {
    return res.status(403).json({
      success: false,
      message: "Access denied.",
    });
  }
  next();
});

router.get("/scan/:barcode", async (req, res) => {
  const { barcode } = req.params;
  try {
    const { data: product, error } = await supabase
      .from("products")
      .select("*")
      .eq("barcode", barcode)
      .single();

    if (error || !product) {
      return res.status(404).json({
        success: false,
        message: "Product not found. Register it first.",
        barcode,
      });
    }

    return res.status(200).json({ success: true, product });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

router.post("/add", async (req, res) => {
  const { product_id, hotel_id, quantity, unit_cost, supplier } = req.body;

  if (!product_id || !hotel_id || !quantity) {
    return res.status(400).json({
      success: false,
      message: "product_id, hotel_id, and quantity are required.",
    });
  }

  try {
    await supabase.from("purchases").insert({
      product_id,
      quantity,
      unit_cost: unit_cost || 0,
      total_cost: (unit_cost || 0) * quantity,
      supplier: supplier || "Not specified",
      purchased_at: new Date().toISOString(),
    });

    const { data: existing } = await supabase
      .from("inventory")
      .select("*")
      .eq("product_id", product_id)
      .eq("hotel_id", hotel_id)
      .single();

    if (existing) {
      const { data: updated, error: updErr } = await supabase
        .from("inventory")
        .update({
          quantity_assigned: existing.quantity_assigned + quantity,
          quantity_remaining: existing.quantity_remaining + quantity,
          last_updated: new Date().toISOString(),
        })
        .eq("id", existing.id)
        .select()
        .single();
      if (updErr) throw updErr;

      return res.status(200).json({
        success: true,
        message: `Stock increased by ${quantity} units.`,
        inventory: updated,
        action: "updated",
      });
    } else {
      const { data: created, error: insErr } = await supabase
        .from("inventory")
        .insert({
          product_id,
          hotel_id,
          quantity_assigned: quantity,
          quantity_sold: 0,
          quantity_remaining: quantity,
          last_updated: new Date().toISOString(),
        })
        .select()
        .single();
      if (insErr) throw insErr;

      return res.status(201).json({
        success: true,
        message: `${quantity} units added to inventory.`,
        inventory: created,
        action: "created",
      });
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Inventory add error:`, err.message, err.code || "", err.details || "", err.hint || "");
    return res.status(500).json({ success: false, message: "Could not assign stock." });
  }
});

router.get("/hotel/:hotel_id", async (req, res) => {
  const { hotel_id } = req.params;
  try {
    const { data: inventory, error } = await supabase
      .from("inventory")
      .select("*, products(*), hotels(name)")
      .eq("hotel_id", hotel_id)
      .order("last_updated", { ascending: false });

    if (error) throw error;

    return res.status(200).json({ success: true, inventory });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Hotel inventory error (hotel ${hotel_id}):`, err.message, err.code || "", err.details || "", err.hint || "");
    return res.status(500).json({ success: false, message: "Server error" });
  }
});


router.get("/all", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("inventory")
      .select("*, products(name, sku, image_url), hotels(name)")
      .order("last_updated", { ascending: false });
    if (error) throw error;
    return res.json({ success: true, inventory: data || [] });
  } catch { return res.status(500).json({ success: false, message: "Server error" }); }
});


// Hotel sets its own margin (%) on top of the supply price. Admin may set it too.
router.put("/:id/margin", async (req, res) => {
  const margin = Number(req.body?.margin_percent);
  if (!Number.isFinite(margin) || margin < 0 || margin > 500) {
    return res.status(400).json({ success: false, message: "Margin must be between 0 and 500 percent." });
  }
  const margin_percent = Math.round(margin * 100) / 100;

  try {
    const { data: inv } = await supabase
      .from("inventory").select("id, hotel_id").eq("id", req.params.id).single();
    if (!inv) return res.status(404).json({ success: false, message: "Stock record not found." });

    if (req.user.role === "hotel_staff" && inv.hotel_id !== req.user.hotel_id) {
      return res.status(403).json({ success: false, message: "Access denied." });
    }

    const { data, error } = await supabase
      .from("inventory")
      .update({ margin_percent })
      .eq("id", req.params.id)
      .select("*, products(name, unit_price)")
      .single();
    if (error) throw error;

    return res.json({ success: true, message: "Margin saved.", inventory: data });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Margin update error:`, err.message, err.code || "");
    return res.status(500).json({ success: false, message: "Could not save margin." });
  }
});

router.put("/:id", async (req, res) => {
  const { quantity_assigned, quantity_remaining, quantity_sold, reason } = req.body;
  if (quantity_assigned === undefined || quantity_remaining === undefined || quantity_sold === undefined) {
    return res.status(400).json({ success: false, message: "All quantity fields are required." });
  }
  if (quantity_remaining + quantity_sold !== quantity_assigned) {
    return res.status(400).json({ success: false, message: "Remaining + sold must equal assigned quantity." });
  }
  try {
    const { data, error } = await supabase
      .from("inventory")
      .update({ quantity_assigned, quantity_remaining, quantity_sold, last_updated: new Date().toISOString() })
      .eq("id", req.params.id)
      .select("*, products(name), hotels(name)")
      .single();
    if (error) throw error;
    await supabase.from("notifications").insert({
      message: `Stock corrected — ${data.products?.name} at ${data.hotels?.name}. Reason: ${reason || "Manual correction"}. New stock: ${quantity_remaining} remaining.`,
      is_read: false,
      created_at: new Date().toISOString(),
    });
    return res.json({ success: true, inventory: data, message: "Inventory updated successfully." });
  } catch { return res.status(500).json({ success: false, message: "Server error" }); }
});


router.delete("/:id", async (req, res) => {
  try {
    const { data: inv } = await supabase
      .from("inventory")
      .select("*, products(name), hotels(name)")
      .eq("id", req.params.id)
      .single();
    const { error } = await supabase.from("inventory").delete().eq("id", req.params.id);
    if (error) throw error;
    await supabase.from("notifications").insert({
      message: `Inventory record deleted — ${inv?.products?.name} at ${inv?.hotels?.name}.`,
      is_read: false,
      created_at: new Date().toISOString(),
    });
    return res.json({ success: true, message: "Inventory record deleted." });
  } catch { return res.status(500).json({ success: false, message: "Server error" }); }
});

module.exports = router;