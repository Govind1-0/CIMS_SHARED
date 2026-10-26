const express  = require("express");
const router   = express.Router();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const { requireAuth } = require("../middleware/auth");
router.use(requireAuth);

const crypto = require("crypto");

// ---- product images (Supabase Storage) ----
const IMAGE_BUCKET    = "product-images";
const IMAGE_MAX_BYTES = 2 * 1024 * 1024;           // 2 MB after decoding
const IMAGE_TYPES     = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

// Only treat a URL as ours if it points into our public bucket
function storedImagePath(url) {
  if (!url || !process.env.SUPABASE_URL) return null;
  const prefix = `${process.env.SUPABASE_URL.replace(/\/$/, "")}/storage/v1/object/public/${IMAGE_BUCKET}/`;
  const u = String(url);
  if (!u.startsWith(prefix)) return null;
  try { return decodeURIComponent(u.slice(prefix.length).split("?")[0]); } catch { return null; }
}

// Best-effort cleanup: never blocks or fails the request
async function removeStoredImage(url) {
  const path = storedImagePath(url);
  if (!path) return;
  try {
    await supabase.storage.from(IMAGE_BUCKET).remove([path]);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Image cleanup failed:`, err.message);
  }
}

// Check the real file signature so a fake content-type can't sneak through
function looksLikeImage(buf, type) {
  if (type === "image/jpeg") return buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
  if (type === "image/png")  return buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
  if (type === "image/webp") return buf.length > 12 && buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP";
  return false;
}


router.use((req, res, next) => {
  const hotel_id = req.params.hotel_id || req.query.hotel_id || req.body?.hotel_id;

  if (req.user.role === "hotel_staff" && hotel_id && hotel_id !== req.user.hotel_id) {
    return res.status(403).json({
      success: false,
      message: "Access denied — you can only access your own hotel data.",
    });
  }
  next();
});

router.get("/reports/sales", async (req, res) => {
  const { days, hotel_id } = req.query;
  const since = new Date();
  since.setDate(since.getDate() - (parseInt(days) || 30));

  try {
    let query = supabase
      .from("sales")
      .select("*, products(name), hotels(name)")
      .gte("sold_at", since.toISOString())
      .order("sold_at", { ascending: false });

    if (hotel_id) query = query.eq("hotel_id", hotel_id);

    const { data, error } = await query;
    if (error) throw error;
    return res.json({ success: true, sales: data || [] });
  } catch { return res.status(500).json({ success: false, message: "Server error" }); }
});

router.get("/reports/dues", async (req, res) => {
  try {
    const { data: hotels } = await supabase.from("hotels").select("id, name");
    const dues = await Promise.all(hotels.map(async h => {
      const { data: payments } = await supabase
        .from("payments").select("amount")
        .eq("hotel_id", h.id).in("status", ["pending", "partial"]);
      const total = payments?.reduce((s, p) => s + Number(p.amount), 0) || 0;
      return { hotel_name: h.name, total };
    }));
    return res.json({ success: true, dues });
  } catch { return res.status(500).json({ success: false, message: "Server error" }); }
});



router.get("/stats", async (req, res) => {
  try {
    const [hotels, products, sales, payments] = await Promise.all([
      supabase.from("hotels").select("id", { count: "exact" }).eq("status", "active"),
      supabase.from("products").select("id", { count: "exact" }),
      supabase.from("sales").select("id", { count: "exact" }),
      supabase.from("payments").select("amount").eq("status", "pending"),
    ]);

    const dues_pending = payments.data?.reduce((sum, p) => sum + Number(p.amount), 0) || 0;

    return res.json({
      success: true,
      stats: {
        hotels:       hotels.count   || 0,
        products:     products.count || 0,
        sales_month: sales.count    || 0,
        dues_pending,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});



router.get("/hotels", async (req, res) => {
  try {
    const { data: hotels, error } = await supabase
      .from("hotels")
      .select("id, name, status, address, contact_person, contact_phone, contact_email")
      .eq("status", "active");

    if (error) throw error;

    const enriched = await Promise.all(hotels.map(async (h) => {
      const [inv, payments] = await Promise.all([
        supabase.from("inventory").select("quantity_remaining, quantity_sold").eq("hotel_id", h.id),
        supabase.from("payments").select("amount").eq("hotel_id", h.id).eq("status", "pending"),
      ]);

      const stock = inv.data?.reduce((s, i) => s + i.quantity_remaining, 0) || 0;
      const sold  = inv.data?.reduce((s, i) => s + i.quantity_sold, 0)      || 0;
      const dues  = payments.data?.reduce((s, p) => s + Number(p.amount), 0) || 0;

      return { ...h, stock, sold, dues };
    }));

    return res.json({ success: true, hotels: enriched });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});


const handleAddHotel = async (req, res) => {
  const { name, address, contact_person, contact_phone, contact_email, status } = req.body;

  if (!name) {
    return res.status(400).json({ success: false, message: "Hotel name is required." });
  }

  try {
    const { data, error } = await supabase
      .from("hotels")
      .insert({
        name,
        address: address || null,
        contact_person: contact_person || null,
        contact_phone: contact_phone || null,
        contact_email: contact_email || null,
        status: status ? status.toLowerCase() : "active",
      })
      .select()
      .single();

    if (error) {
      console.error("Supabase Error:", error.message);
      return res.status(400).json({ success: false, message: error.message });
    }

    return res.status(201).json({ success: true, hotel: data });
  } catch (err) {
    console.error("Server Error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

router.post("/hotels/add", handleAddHotel);
router.post("/hotels", handleAddHotel);

router.put("/hotels/:id", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("hotels")
      .update(req.body)
      .eq("id", req.params.id)
      .select()
      .single();

    if (error) throw error;
    return res.json({ success: true, hotel: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

router.delete("/hotels/:id", async (req, res) => {
  try {
    const { error } = await supabase.from("hotels").delete().eq("id", req.params.id);
    if (error) throw error;
    return res.json({ success: true, message: "Hotel deleted." });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});



router.get("/sales/recent", async (req, res) => {
  try {
    const { data: sales, error } = await supabase
      .from("sales")
      .select("*, products(name), hotels(name)")
      .order("sold_at", { ascending: false })
      .limit(10);

    if (error) throw error;

    return res.json({ success: true, sales });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

router.get("/notifications", async (req, res) => {
  try {
    const { data: notifications, error } = await supabase
      .from("notifications")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(20);

    if (error) throw error;

    return res.json({ success: true, notifications: notifications || [] });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

router.post("/notifications/read-all", async (req, res) => {
  try {
    await supabase
      .from("notifications")
      .update({ is_read: true })
      .eq("is_read", false);

    return res.json({ success: true, message: "All marked as read" });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

router.get("/hotel/stats", async (req, res) => {
  try {
    const hotel_id = req.user?.hotel_id;
    if (!hotel_id) return res.status(400).json({ success: false, message: "No hotel assigned." });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

    const [inv, todaySales, monthSales, payments] = await Promise.all([
      supabase.from("inventory").select("quantity_remaining").eq("hotel_id", hotel_id),
      supabase.from("sales").select("id", { count: "exact" }).eq("hotel_id", hotel_id).gte("sold_at", today.toISOString()),
      supabase.from("sales").select("id", { count: "exact" }).eq("hotel_id", hotel_id).gte("sold_at", monthStart.toISOString()),
      supabase.from("payments").select("amount").eq("hotel_id", hotel_id).eq("status", "pending"),
    ]);

    const stock = inv.data?.reduce((s, i) => s + i.quantity_remaining, 0) || 0;
    const dues  = payments.data?.reduce((s, p) => s + Number(p.amount), 0) || 0;

    return res.json({
      success: true,
      stats: {
        stock,
        today: todaySales.count || 0,
        month: monthSales.count || 0,
        dues,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

router.get("/sales/hotel/:hotel_id", async (req, res) => {
  try {
    const { hotel_id } = req.params;

    const { data: sales, error } = await supabase
      .from("sales")
      .select("*, products(name), hotels(name)")
      .eq("hotel_id", hotel_id)
      .order("sold_at", { ascending: false })
      .limit(50);

    if (error) throw error;

    return res.json({ success: true, sales: sales || [] });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

router.get("/payments/hotel/:hotel_id", async (req, res) => {
  try {
    const { hotel_id } = req.params;

    const { data: payments, error } = await supabase
      .from("payments")
      .select("*")
      .eq("hotel_id", hotel_id)
      .in("status", ["pending", "partial"])
      .order("due_date", { ascending: true });

    if (error) throw error;

    return res.json({ success: true, payments: payments || [] });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

router.get("/payments", async (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ success: false, message: "Admin access required." });
  }
  try {
    const [pay, hot] = await Promise.all([
      supabase.from("payments").select("*").order("due_date", { ascending: true, nullsFirst: false }),
      supabase.from("hotels").select("id, name"),
    ]);
    if (pay.error) throw pay.error;

    const names = {};
    (hot.data || []).forEach(h => { names[h.id] = h.name; });

    const payments = (pay.data || []).map(p => ({ ...p, hotel_name: names[p.hotel_id] || "Unknown hotel" }));
    return res.json({ success: true, payments });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Payments list error:`, err.message);
    return res.status(500).json({ success: false, message: "Server error." });
  }
});

router.post("/payments", async (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ success: false, message: "Admin access required." });
  }

  const { hotel_id, due_date } = req.body;
  const amount = Number(req.body.amount);
  const notes  = String(req.body.notes || "").trim().slice(0, 200);

  if (!hotel_id)                          return res.status(400).json({ success: false, message: "Hotel is required." });
  if (!Number.isFinite(amount) || amount <= 0)
                                          return res.status(400).json({ success: false, message: "Enter a valid amount." });
  if (due_date && Number.isNaN(Date.parse(due_date)))
                                          return res.status(400).json({ success: false, message: "Invalid due date." });

  try {
    const { data: hotel } = await supabase.from("hotels").select("name").eq("id", hotel_id).single();
    if (!hotel) return res.status(404).json({ success: false, message: "Hotel not found." });

    const { data: payment, error } = await supabase
      .from("payments")
      .insert({ hotel_id, amount, status: "pending", due_date: due_date || null, notes: notes || null })
      .select()
      .single();
    if (error) throw error;

    await supabase.from("notifications").insert({
      message:    `New due of \u20B9${amount.toLocaleString()} added for ${hotel.name}.`,
      is_read:    false,
      created_at: new Date().toISOString(),
    });

    return res.status(201).json({ success: true, message: "Due added.", payment });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Payment create error:`, err.message);
    return res.status(500).json({ success: false, message: "Server error." });
  }
});

router.delete("/payments/:id", async (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ success: false, message: "Admin access required." });
  }
  try {
    const { data, error } = await supabase
      .from("payments").delete().eq("id", req.params.id).select().single();
    if (error || !data) return res.status(404).json({ success: false, message: "Payment not found." });
    return res.json({ success: true, message: "Payment deleted." });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Payment delete error:`, err.message);
    return res.status(500).json({ success: false, message: "Server error." });
  }
});

router.put("/payments/:id", async (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ success: false, message: "Admin access required." });
  }

  const status  = String(req.body.status || "paid").toLowerCase();
  const allowed = ["paid", "pending", "partial", "overdue"];
  if (!allowed.includes(status)) {
    return res.status(400).json({ success: false, message: "Invalid payment status." });
  }

  try {
    const { data: payment, error } = await supabase
      .from("payments")
      .update({ status })
      .eq("id", req.params.id)
      .select()
      .single();

    if (error || !payment) {
      return res.status(404).json({ success: false, message: "Payment not found." });
    }

    const { data: hotel } = await supabase
      .from("hotels").select("name").eq("id", payment.hotel_id).single();

    await supabase.from("notifications").insert({
      message:    `Payment of \u20B9${Number(payment.amount).toLocaleString()} marked as ${status} \u2014 ${hotel?.name || "hotel"}.`,
      is_read:    false,
      created_at: new Date().toISOString(),
    });

    return res.json({ success: true, message: `Payment marked as ${status}.`, payment });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Payment update error:`, err.message);
    return res.status(500).json({ success: false, message: "Server error." });
  }
});

router.post("/sales/record", async (req, res) => {
  const { product_id, hotel_id, quantity, recorded_by } = req.body;

  if (!product_id || !hotel_id || !quantity) {
    return res.status(400).json({
      success: false,
      message: "product_id, hotel_id and quantity are required.",
    });
  }

  if (!Number.isInteger(quantity) || quantity < 1) {
    return res.status(400).json({
      success: false,
      message: "Quantity must be a positive whole number.",
    });
  }

  try {
    
    const { data: product, error: productError } = await supabase
      .from("products")
      .select("unit_price, name")
      .eq("id", product_id)
      .single();

    if (productError || !product) {
      return res.status(404).json({ success: false, message: "Product not found." });
    }

    const sale_price = product.unit_price;

    if (!sale_price || sale_price <= 0) {
      return res.status(400).json({ success: false, message: "Product has no valid price set." });
    }

    
    if (req.user.role === "hotel_staff" && req.user.hotel_id !== hotel_id) {
      return res.status(403).json({ success: false, message: "You can only record sales for your own hotel." });
    }

    
    const { data: inv, error: invError } = await supabase
      .from("inventory")
      .select("*")
      .eq("product_id", product_id)
      .eq("hotel_id", hotel_id)
      .single();

    if (invError || !inv) {
      return res.status(404).json({ success: false, message: "This product is not assigned to this hotel." });
    }

    
    if (inv.quantity_remaining < quantity) {
      return res.status(400).json({
        success: false,
        message: `Only ${inv.quantity_remaining} units available. Cannot sell ${quantity}.`,
      });
    }

    if (inv.quantity_remaining === 0) {
      return res.status(400).json({ success: false, message: "This item is out of stock." });
    }

    
    const { data: updatedInv, error: updateError } = await supabase
      .from("inventory")
      .update({
        quantity_sold:      inv.quantity_sold + quantity,
        quantity_remaining: inv.quantity_remaining - quantity,
        last_updated:       new Date().toISOString(),
      })
      .eq("id", inv.id)
      .eq("quantity_remaining", inv.quantity_remaining) 
      .select()
      .single();

    if (updateError || !updatedInv) {
      return res.status(409).json({
        success: false,
        message: "Sale could not be processed — stock was updated by another transaction. Please try again.",
      });
    }

    
    const { data: sale, error: saleError } = await supabase
      .from("sales")
      .insert({
        inventory_id:  inv.id,
        hotel_id,
        product_id,
        recorded_by:   recorded_by || null,
        quantity_sold: quantity,
        sale_price,
        total_amount:  quantity * sale_price,
        sold_at:       new Date().toISOString(),
      })
      .select()
      .single();

    if (saleError) throw saleError;

    
    await supabase.from("notifications").insert({
      sale_id:    sale.id,
      message:    `Sale recorded — ${product.name} x${quantity} at hotel ${hotel_id} for \u20B9${(quantity * sale_price).toLocaleString()}`,
      is_read:    false,
      created_at: new Date().toISOString(),
    });

    return res.status(201).json({
      success: true,
      message: "Sale recorded successfully.",
      sale,
    });

  } catch (err) {
    console.error(`[${new Date().toISOString()}] Sale error:`, err.message);
    return res.status(500).json({ success: false, message: "Server error." });
  }
});

router.post("/hotel/assist", async (req, res) => {
  const { hotel_id, hotel_name, message, user_id } = req.body;

  if (!hotel_id || !message) {
    return res.status(400).json({ success: false, message: "Missing required fields." });
  }

  try {
    const { error } = await supabase.from("notifications").insert({
      message:    `Assistance requested by ${hotel_name} — ${message}`,
      is_read:    false,
      created_at: new Date().toISOString(),
    });

    if (error) throw error;

    return res.json({ success: true, message: "Request sent to admin." });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error." });
  }
});



router.get("/products", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("products")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return res.json({ success: true, products: data || [] });
  } catch { return res.status(500).json({ success: false, message: "Server error" }); }
});

router.post("/products/upload", async (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ success: false, message: "Admin access required." });
  }

  const dataUrl = String(req.body?.image || "");
  const marker  = ";base64,";
  const cut     = dataUrl.indexOf(marker);
  const type    = dataUrl.startsWith("data:") && cut > 5 ? dataUrl.slice(5, cut) : "";

  if (!IMAGE_TYPES[type]) {
    return res.status(400).json({ success: false, message: "Only JPEG, PNG or WebP images are allowed." });
  }

  const buffer = Buffer.from(dataUrl.slice(cut + marker.length), "base64");
  if (!buffer.length)                  return res.status(400).json({ success: false, message: "Empty image." });
  if (buffer.length > IMAGE_MAX_BYTES) return res.status(413).json({ success: false, message: "Image is too large (max 2 MB)." });
  if (!looksLikeImage(buffer, type))   return res.status(400).json({ success: false, message: "That file is not a valid image." });

  const path = `products/${crypto.randomUUID()}.${IMAGE_TYPES[type]}`;

  try {
    const { error } = await supabase.storage
      .from(IMAGE_BUCKET)
      .upload(path, buffer, { contentType: type, cacheControl: "31536000", upsert: false });

    if (error) {
      console.error(`[${new Date().toISOString()}] Image upload error:`, error.message);
      const missing = /bucket/i.test(error.message || "") && /not found/i.test(error.message || "");
      return res.status(500).json({
        success: false,
        message: missing
          ? "Image storage is not set up yet (create the 'product-images' bucket in Supabase)."
          : "Could not store the image.",
      });
    }

    const { data } = supabase.storage.from(IMAGE_BUCKET).getPublicUrl(path);
    return res.status(201).json({ success: true, url: data.publicUrl });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Image upload error:`, err.message);
    return res.status(500).json({ success: false, message: "Server error." });
  }
});

router.post("/products/add", async (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ success: false, message: "Admin access required." });
  }
  const { name, description, origin_country, category, barcode, sku, unit_price, image_url } = req.body;
  if (!name)    return res.status(400).json({ success: false, message: "Product name is required." });
  if (!barcode) return res.status(400).json({ success: false, message: "Barcode is required." });
  if (!sku)     return res.status(400).json({ success: false, message: "SKU is required." });
  try {
    const { data, error } = await supabase
      .from("products")
      .insert({ name, description, origin_country, category, barcode, sku, unit_price: unit_price || 0, image_url })
      .select().single();
    if (error) throw error;
    return res.status(201).json({ success: true, product: data });
  } catch (err) {
    const msg = err.message?.includes("unique") ? "Barcode or SKU already exists." : "Server error";
    return res.status(500).json({ success: false, message: msg });
  }
});

router.put("/products/:id", async (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ success: false, message: "Admin access required." });
  }
  const { name, description, origin_country, category, barcode, sku, unit_price, image_url } = req.body;

  if (!name)    return res.status(400).json({ success: false, message: "Product name is required." });
  if (!barcode) return res.status(400).json({ success: false, message: "Barcode is required." });
  if (!sku)     return res.status(400).json({ success: false, message: "SKU is required." });
  if (unit_price < 0) return res.status(400).json({ success: false, message: "Price cannot be negative." });

  try {
    const { data: before } = await supabase
      .from("products").select("image_url").eq("id", req.params.id).single();

    const { data, error } = await supabase
      .from("products")
      .update({ name, description, origin_country, category, barcode, sku, unit_price, image_url })
      .eq("id", req.params.id)
      .select().single();
    if (error) throw error;

    // photo was replaced or removed -> delete the old file from our bucket
    if (before?.image_url && before.image_url !== image_url) await removeStoredImage(before.image_url);

    return res.json({ success: true, product: data });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Product update error:`, err.message);
    return res.status(500).json({ success: false, message: "Server error." });
  }
});

router.delete("/products/:id", async (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ success: false, message: "Admin access required." });
  }
  try {
    const { data: before } = await supabase
      .from("products").select("image_url").eq("id", req.params.id).single();

    const { error } = await supabase.from("products").delete().eq("id", req.params.id);
    if (error) throw error;

    if (before?.image_url) await removeStoredImage(before.image_url);

    return res.json({ success: true, message: "Product deleted." });
  } catch { return res.status(500).json({ success: false, message: "Server error" }); }
});



router.get("/staff", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("users")
      .select("id, name, email, role, hotel_id, status, created_at, hotels(name)")
      .eq("role", "hotel_staff")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return res.json({ success: true, staff: data || [] });
  } catch { return res.status(500).json({ success: false, message: "Server error" }); }
});

router.put("/staff/:id", async (req, res) => {
  const { name, email, password, hotel_id, status } = req.body;

  if (!name)     return res.status(400).json({ success: false, message: "Name is required." });
  if (!email)    return res.status(400).json({ success: false, message: "Email is required." });
  if (!hotel_id) return res.status(400).json({ success: false, message: "Hotel is required." });

  const updates = { name, email, hotel_id, status };

  try {
    if (password) {
      if (password.length < 8) {
        return res.status(400).json({ success: false, message: "Password must be at least 8 characters." });
      }
      const bcrypt = require("bcryptjs");
      updates.password_hash = await bcrypt.hash(password, 12);
    }

    const { data, error } = await supabase
      .from("users")
      .update(updates)
      .eq("id", req.params.id)
      .eq("role", "hotel_staff")
      .select("id, name, email, role, hotel_id, status")
      .single();

    if (error) throw error;
    return res.json({ success: true, staff: data });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Staff update error:`, err.message);
    return res.status(500).json({ success: false, message: "Server error." });
  }
});

router.delete("/staff/:id", async (req, res) => {
  try {
    const { error } = await supabase.from("users").delete().eq("id", req.params.id);
    if (error) throw error;
    return res.json({ success: true, message: "Staff account deleted." });
  } catch { return res.status(500).json({ success: false, message: "Server error" }); }
});

module.exports = router;