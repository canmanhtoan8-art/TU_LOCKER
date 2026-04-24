require("dotenv").config();

const express = require("express");
const admin = require("firebase-admin");
const path = require("path");
const fetch = require("node-fetch");

const app = express();
const port = process.env.PORT || 3000;

const SHEET_API_URL = process.env.SHEET_API_URL || "";
console.log("📄 SHEET_API_URL:", SHEET_API_URL);

/* ================= PARSE BODY ================= */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ================= FIREBASE ================= */
const serviceAccount = require("./firebase-key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL,
});

const db = admin.database();

/* ================= STATIC ================= */
app.use(express.static(__dirname));

/* ================= CONFIG ================= */
const BANK_CODE = process.env.BANK_CODE || "MB";
const ACCOUNT_NO = process.env.ACCOUNT_NO || "0388601940";
const ACCOUNT_NAME = process.env.ACCOUNT_NAME || "CAN MANH TOAN";
const QR_TEMPLATE = process.env.QR_TEMPLATE || "compact2";
const PAYMENT_AMOUNT = Number(process.env.PAYMENT_AMOUNT || 1000);

/*
  MAP PHẦN CỨNG THỰC TẾ
  Tủ 1 -> relay/pin 4
  Tủ 2 -> relay/pin 16
  Tủ 3 -> relay/pin 17
  Tủ 4 -> relay/pin 18
  Tủ 5 -> relay/pin 5
  Tủ 6 -> relay/pin 19
  Tủ 7 -> relay/pin 21
  Tủ 8 -> relay/pin 22

  Trên Firebase, ESP32 sẽ lắng nghe:
  locker/1/open ... locker/8/open
*/
const HARDWARE_LOCKER_MAP = {
  "1": "1",
  "2": "2",
  "3": "3",
  "4": "4",
  "5": "5",
  "6": "6",
  "7": "7",
  "8": "8",
};

/* ================= HELPER ================= */
function makeOrderId() {
  return Date.now().toString();
}

function makeTransferContent(lockerId, orderId) {
  return `TU${lockerId}${orderId}`;
}

function buildQrImageUrl({ amount, content }) {
  return (
    `https://img.vietqr.io/image/${BANK_CODE}-${ACCOUNT_NO}-${QR_TEMPLATE}.png` +
    `?amount=${encodeURIComponent(amount)}` +
    `&addInfo=${encodeURIComponent(content)}` +
    `&accountName=${encodeURIComponent(ACCOUNT_NAME)}`
  );
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeTransferContent(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function getHardwareLockerId(selectedLocker) {
  const lockerId = normalizeText(selectedLocker);
  return HARDWARE_LOCKER_MAP[lockerId] || null;
}

/* ================= HARDWARE OPEN ================= */
async function openLockerHardware(selectedLocker) {
  const hardwareLockerId = getHardwareLockerId(selectedLocker);

  if (!hardwareLockerId) {
    throw new Error(`Tủ ${selectedLocker} chưa có cấu hình phần cứng`);
  }

  console.log(
    `🔓 Yêu cầu mở tủ giao diện: ${selectedLocker} -> mở tủ vật lý: ${hardwareLockerId}`
  );

  await db.ref(`locker/${hardwareLockerId}/open`).set(true);

  setTimeout(async () => {
    try {
      await db.ref(`locker/${hardwareLockerId}/open`).set(false);
      console.log(`🔒 Đóng tủ vật lý: ${hardwareLockerId}`);
    } catch (err) {
      console.error(`Lỗi đóng tủ vật lý ${hardwareLockerId}:`, err);
    }
  }, 5000);
}

/* ================= GOOGLE SHEET ================= */
async function fetchSheetJson() {
  if (!SHEET_API_URL) {
    console.log("⚠️ Chưa cấu hình SHEET_API_URL");
    return null;
  }

  const response = await fetch(SHEET_API_URL);
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch (e) {
    console.log("⚠️ Apps Script không trả JSON, bỏ qua lượt này");
    return null;
  }
}

async function checkGoogleSheetTransaction(order) {
  try {
    const result = await fetchSheetJson();

    if (!result || result.error || !Array.isArray(result.data)) {
      return false;
    }

    const orderContent = normalizeTransferContent(order.transferContent);
    const orderAmount = Number(order.amount);

    for (const tx of result.data) {
      const txContent = normalizeTransferContent(
        tx["Nội dung"] ||
          tx["Noi dung"] ||
          tx["Mô tả"] ||
          tx["Mo ta"] ||
          tx["content"] ||
          tx["description"] ||
          tx["Description"] ||
          ""
      );

      const txAmount = Number(
        String(
          tx["Số tiền"] ||
            tx["So tien"] ||
            tx["Giá trị"] ||
            tx["Gia tri"] ||
            tx["amount"] ||
            tx["Amount"] ||
            0
        ).replace(/[^\d.-]/g, "")
      );

      if (!txContent || !txAmount) {
        continue;
      }

      if (txContent.includes(orderContent) && txAmount === orderAmount) {
        console.log("✅ Khớp giao dịch Google Sheet:", tx);
        return true;
      }
    }

    return false;
  } catch (error) {
    console.error("❌ Lỗi checkGoogleSheetTransaction:", error);
    return false;
  }
}

/* ================= HOME ================= */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

/* ================= CREATE QR PAGE ================= */
app.get("/qr", async (req, res) => {
  try {
    const lockerId = normalizeText(req.query.locker);
    const hardwareLockerId = getHardwareLockerId(lockerId);

    if (!lockerId) {
      return res.status(400).send("Thiếu locker");
    }

    if (!hardwareLockerId) {
      return res.status(400).send(`Tủ ${lockerId} chưa có phần cứng`);
    }

    const orderId = makeOrderId();
    const transferContent = makeTransferContent(lockerId, orderId);
    const qrImageUrl = buildQrImageUrl({
      amount: PAYMENT_AMOUNT,
      content: transferContent,
    });

    await db.ref(`orders/${orderId}`).set({
      orderId,
      lockerId,
      hardwareLockerId,
      amount: PAYMENT_AMOUNT,
      transferContent,
      status: "pending",
      createdAt: Date.now(),
      paidAt: null,
      transactionCode: "",
      callbackPayload: {
        source: "google_sheet_waiting",
      },
    });

    res.send(`
      <!DOCTYPE html>
      <html lang="vi">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Quét QR thanh toán</title>
        <style>
          body{
            font-family: Arial, sans-serif;
            text-align:center;
            background:#f4f6f8;
            padding:30px;
          }
          .box{
            max-width:430px;
            margin:auto;
            background:#fff;
            padding:25px;
            border-radius:20px;
            box-shadow:0 8px 24px rgba(0,0,0,0.15);
          }
          img{
            width:300px;
            margin:20px 0;
            border-radius:16px;
            background:#fff;
          }
          h2{
            margin-bottom:10px;
          }
          p{
            color:#333;
            line-height:1.5;
          }
          .code{
            font-weight:bold;
            color:#0d47a1;
            word-break:break-word;
            margin:8px 0 12px;
          }
          .note{
            color:#666;
            font-size:14px;
          }
        </style>
      </head>
      <body>
        <div class="box">
          <h2>Quét QR để thanh toán</h2>
          <p>Tủ đã chọn trên giao diện: <b>${lockerId}</b></p>
          <p>Tủ vật lý sẽ mở: <b>${hardwareLockerId}</b></p>
          <p>Số tiền: <b>${PAYMENT_AMOUNT.toLocaleString("vi-VN")}đ</b></p>
          <p>Nội dung chuyển khoản:</p>
          <div class="code">${transferContent}</div>
          <img src="${qrImageUrl}" alt="QR thanh toán" />
          <p>Đang chờ thanh toán...</p>
          <p class="note">Hệ thống đang kiểm tra giao dịch từ Google Sheet.</p>
        </div>

        <script>
          const orderId = "${orderId}";
          const lockerId = "${lockerId}";

          setInterval(async () => {
            try {
              await fetch("/check-sheet-payment?orderId=" + encodeURIComponent(orderId));

              const response = await fetch("/order-status?orderId=" + encodeURIComponent(orderId));
              const data = await response.json();

              if (data.status === "paid") {
                window.location.href = "/?paid=" + encodeURIComponent(lockerId);
              }
            } catch (err) {
              console.log("Lỗi kiểm tra thanh toán:", err);
            }
          }, 2000);
        </script>
      </body>
      </html>
    `);
  } catch (error) {
    console.error("Lỗi tạo QR:", error);
    res.status(500).send("Lỗi tạo QR");
  }
});

/* ================= ORDER STATUS FOR POLLING ================= */
app.get("/order-status", async (req, res) => {
  try {
    const orderId = normalizeText(req.query.orderId);
    if (!orderId) {
      return res.status(400).json({ status: "missing_order_id" });
    }

    const snap = await db.ref(`orders/${orderId}`).once("value");
    const data = snap.val();

    if (!data) {
      return res.json({ status: "not_found" });
    }

    return res.json({
      status: data.status || "unknown",
      lockerId: data.lockerId || "",
      hardwareLockerId: data.hardwareLockerId || "",
      amount: data.amount || 0,
      transferContent: data.transferContent || "",
    });
  } catch (error) {
    console.error("Lỗi order-status:", error);
    res.status(500).json({ status: "error" });
  }
});

/* ================= CHECK PAYMENT FROM GOOGLE SHEET ================= */
app.get("/check-sheet-payment", async (req, res) => {
  try {
    const orderId = normalizeText(req.query.orderId);

    if (!orderId) {
      return res.status(400).json({ ok: false, status: "missing_order_id" });
    }

    const snap = await db.ref(`orders/${orderId}`).once("value");
    const order = snap.val();

    if (!order) {
      return res.status(404).json({ ok: false, status: "not_found" });
    }

    if (order.status === "paid") {
      return res.json({ ok: true, status: "paid" });
    }

    const matched = await checkGoogleSheetTransaction(order);

    if (!matched) {
      return res.json({ ok: true, status: "pending" });
    }

    await db.ref(`orders/${orderId}`).update({
      status: "paid",
      paidAt: Date.now(),
      transactionCode: "GOOGLE_SHEET_DEMO",
      callbackPayload: {
        source: "google_sheet_polling",
      },
    });

    await openLockerHardware(order.lockerId);

    return res.json({ ok: true, status: "paid" });
  } catch (error) {
    console.error("Lỗi check-sheet-payment:", error);
    return res.status(500).json({ ok: false, status: "error" });
  }
});

/* ================= OPEN LOCKER MANUAL ================= */
app.get("/open-locker/:id", async (req, res) => {
  try {
    const lockerId = normalizeText(req.params.id);

    if (!lockerId) {
      return res.status(400).send("Thiếu mã tủ");
    }

    const hardwareLockerId = getHardwareLockerId(lockerId);

    if (!hardwareLockerId) {
      return res.status(400).send(`Tủ ${lockerId} chưa có phần cứng`);
    }

    await openLockerHardware(lockerId);

    res.send(
      `Đã mở tủ  ${lockerId}`
    );
  } catch (error) {
    console.error("Lỗi open-locker:", error);
    res.status(500).send("Lỗi mở tủ");
  }
});

/* ================= DEBUG ORDER LIST ================= */
app.get("/debug-orders", async (req, res) => {
  try {
    const snap = await db.ref("orders").once("value");
    res.json(snap.val() || {});
  } catch (error) {
    console.error("Lỗi debug-orders:", error);
    res.status(500).json({ error: true });
  }
});

/* ================= TEST SHEET ================= */
app.get("/test-sheet", async (req, res) => {
  try {
    const data = await fetchSheetJson();

    if (!data) {
      return res.status(500).json({
        error: true,
        message: "Apps Script không trả JSON hợp lệ",
      });
    }

    console.log("📊 DATA từ Google Sheet:", data);
    res.json(data);
  } catch (err) {
    console.error("❌ ERROR:", err);
    res.status(500).send("Lỗi fetch sheet");
  }
});

/* ================= AUTO POLL SHEET FOR PAID ORDERS ================= */
setInterval(async () => {
  try {
    const snap = await db
      .ref("orders")
      .orderByChild("status")
      .equalTo("pending")
      .once("value");

    const orders = snap.val();
    if (!orders) return;

    for (const orderId of Object.keys(orders)) {
      const order = orders[orderId];
      const matched = await checkGoogleSheetTransaction(order);

      if (!matched) continue;

      console.log(`💰 Phát hiện giao dịch khớp order: ${order.transferContent}`);

      const latestSnap = await db.ref(`orders/${orderId}`).once("value");
      const latestOrder = latestSnap.val();

      if (!latestOrder || latestOrder.status === "paid") {
        continue;
      }

      await db.ref(`orders/${orderId}`).update({
        status: "paid",
        paidAt: Date.now(),
        transactionCode: "GOOGLE_SHEET_DEMO",
        callbackPayload: {
          source: "google_sheet_polling_interval",
        },
      });

      await openLockerHardware(order.lockerId);
    }
  } catch (err) {
    console.error("❌ Lỗi đọc sheet:", err);
  }
}, 3000);
/* ================= ADMIN PAGE ================= */
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

/* ================= ADMIN STATUS ================= */
app.get("/admin-status", async (req, res) => {
  try {
    const items = [];

    for (let i = 1; i <= 8; i++) {
      const lockerId = String(i);
      const hardwareLockerId = getHardwareLockerId(lockerId);

      let openFlag = false;

      if (hardwareLockerId) {
        const snap = await db.ref(`locker/${hardwareLockerId}/open`).once("value");
        openFlag = !!snap.val();
      }

      items.push({
        id: lockerId,
        hardwareLockerId: hardwareLockerId || "",
        openFlag,
      });
    }

    return res.json({
      ok: true,
      items,
    });
  } catch (error) {
    console.error("Lỗi admin-status:", error);
    return res.status(500).json({
      ok: false,
      message: "Lỗi tải trạng thái admin",
    });
  }
});

/* ================= ADMIN OPEN ONE LOCKER ================= */
app.post("/admin-open/:id", async (req, res) => {
  try {
    const lockerId = normalizeText(req.params.id);

    if (!lockerId) {
      return res.status(400).json({
        ok: false,
        message: "Thiếu mã tủ",
      });
    }

    await openLockerHardware(lockerId);

    return res.json({
      ok: true,
      message: `Đã gửi lệnh mở tủ ${lockerId}`,
    });
  } catch (error) {
    console.error("Lỗi admin-open:", error);
    return res.status(500).json({
      ok: false,
      message: "Lỗi mở tủ",
    });
  }
});

/* ================= ADMIN CLOSE ONE FLAG ================= */
app.post("/admin-close/:id", async (req, res) => {
  try {
    const lockerId = normalizeText(req.params.id);
    const hardwareLockerId = getHardwareLockerId(lockerId);

    if (!hardwareLockerId) {
      return res.status(400).json({
        ok: false,
        message: `Tủ ${lockerId} chưa có phần cứng`,
      });
    }

    await db.ref(`locker/${hardwareLockerId}/open`).set(false);

    return res.json({
      ok: true,
      message: `Đã tắt cờ mở tủ ${lockerId}`,
    });
  } catch (error) {
    console.error("Lỗi admin-close:", error);
    return res.status(500).json({
      ok: false,
      message: "Lỗi tắt cờ mở",
    });
  }
});

/* ================= ADMIN OPEN ALL ================= */
app.post("/admin-open-all", async (req, res) => {
  try {
    for (let i = 1; i <= 8; i++) {
      await openLockerHardware(String(i));
    }

    return res.json({
      ok: true,
      message: "Đã gửi lệnh mở tất cả 8 tủ",
    });
  } catch (error) {
    console.error("Lỗi admin-open-all:", error);
    return res.status(500).json({
      ok: false,
      message: "Lỗi mở tất cả tủ",
    });
  }
});

/* ================= ADMIN CLOSE ALL FLAGS ================= */
app.post("/admin-close-all", async (req, res) => {
  try {
    for (let i = 1; i <= 8; i++) {
      const lockerId = String(i);
      const hardwareLockerId = getHardwareLockerId(lockerId);

      if (!hardwareLockerId) continue;

      await db.ref(`locker/${hardwareLockerId}/open`).set(false);
    }

    return res.json({
      ok: true,
      message: "Đã tắt tất cả cờ mở",
    });
  } catch (error) {
    console.error("Lỗi admin-close-all:", error);
    return res.status(500).json({
      ok: false,
      message: "Lỗi tắt tất cả cờ mở",
    });
  }
});
/* ================= ADMIN LOGIN ================= */
app.post("/admin-login", (req, res) => {
  const username = req.body.username;
  const password = req.body.password;

  const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "123456";

  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    return res.status(401).json({
      ok: false,
      message: "Sai tài khoản hoặc mật khẩu",
    });
  }

  return res.json({
    ok: true,
    message: "Đăng nhập thành công",
  });
});
/* ================= LOCKER UI STATE ================= */
app.get("/locker-ui-state", async (req, res) => {
  try {
    const snap = await db.ref("admin/lockerState").once("value");
    const data = snap.val() || {};

    const result = {};

    for (let i = 1; i <= 8; i++) {
      result[i] = {
        status: data[i]?.status || "free"
      };
    }

    return res.json({
      ok: true,
      items: result
    });
  } catch (error) {
    console.error("Lỗi locker-ui-state:", error);
    return res.status(500).json({
      ok: false,
      message: "Lỗi lấy trạng thái tủ"
    });
  }
});
/* ================= SET LOCKER BUSY ================= */
app.post("/admin-set-busy/:id", async (req, res) => {
  try {
    const lockerId = normalizeText(req.params.id);

    if (!lockerId) {
      return res.status(400).json({
        ok: false,
        message: "Thiếu mã tủ"
      });
    }

    await db.ref(`admin/lockerState/${lockerId}`).set({
      status: "busy"
    });

    return res.json({
      ok: true,
      message: `Đã chuyển tủ ${lockerId} sang trạng thái bận`
    });
  } catch (error) {
    console.error("Lỗi admin-set-busy:", error);
    return res.status(500).json({
      ok: false,
      message: "Lỗi set busy"
    });
  }
});
/* ================= RESET LOCKER UI STATE ================= */
app.post("/admin-reset/:id", async (req, res) => {
  try {
    const lockerId = normalizeText(req.params.id);

    if (!lockerId) {
      return res.status(400).json({
        ok: false,
        message: "Thiếu mã tủ"
      });
    }

    await db.ref(`admin/lockerState/${lockerId}`).set({
      status: "free"
    });

    return res.json({
      ok: true,
      message: `Đã reset tủ ${lockerId}`
    });
  } catch (error) {
    console.error("Lỗi admin-reset:", error);
    return res.status(500).json({
      ok: false,
      message: "Lỗi reset tủ"
    });
  }
});
/* ================= RUN ================= */
app.listen(port, () => {
  console.log("🚀 Server chạy tại: http://localhost:" + port);
  console.log("🧰 Hardware locker map:", HARDWARE_LOCKER_MAP);
});