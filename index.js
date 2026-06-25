const dns = require("node:dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const express = require("express");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const cors = require("cors");
require("dotenv").config();

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT;

app.use(
  cors({
    origin: ["https://recipe-hub-client-two.vercel.app"],
    credentials: true,
  }),
);

app.use(express.json());

const uri = process.env.MONGO_DB_URI;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();
    console.log("Database connected successfully to MongoDB!");

    const db = client.db("RecipeHubDB");

    const userCollection = db.collection("user");
    const recipeCollection = db.collection("recipes");
    const paymentCollection = db.collection("payments");
    const favoriteCollection = db.collection("favorites");
    const reportCollection = db.collection("reports");

    // ROLE & BLOCK CHECK API
    app.get("/check-user-role", async (req, res) => {
      try {
        const { email } = req.query;
        if (!email) {
          return res
            .status(400)
            .send({ success: false, message: "Email parameter is required" });
        }

        const user = await userCollection.findOne({ email: email });
        if (!user) {
          return res
            .status(404)
            .send({ success: false, message: "User not found in database" });
        }

        let finalRole = user.role || "user";
        if (email === "admin@recipehub.com") {
          finalRole = "admin";
        }

        if (user.isBlocked === true && finalRole !== "admin") {
          return res.send({
            success: true,
            isBlocked: true,
            message: "This account has been blocked by the Administrator.",
          });
        }

        res.send({
          success: true,
          isBlocked: false,
          data: {
            role: finalRole,
            isPremium: user.isPremium || false,
          },
        });
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // ADDED FOR PROFILE PAGE SYNC
    app.get("/api/user/status", async (req, res) => {
      try {
        const { email } = req.query;
        if (!email) {
          return res
            .status(400)
            .send({ success: false, message: "Email is required" });
        }
        const user = await userCollection.findOne({ email: email });
        if (!user) {
          return res
            .status(404)
            .send({ success: false, message: "User not found" });
        }
        return res.status(200).send({
          success: true,
          isPremium: user.isPremium || false,
        });
      } catch (error) {
        return res.status(500).send({ success: false, message: error.message });
      }
    });

    // Recipe GET API (With Category $in & Search Filtering)
    app.get("/recipes", async (req, res) => {
      try {
        const { search, category, page = 1, limit = 6 } = req.query;
        let query = {};

        if (search) {
          query.recipeName = { $regex: search, $options: "i" };
        }
        if (category && category !== "All") {
          query.category = { $in: [category] };
        }
        const totalRecipes = await recipeCollection.countDocuments(query);

        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const skip = (pageNum - 1) * limitNum;

        const result = await recipeCollection
          .find(query)
          .skip(skip)
          .limit(limitNum)
          .toArray();

        res.send({
          success: true,
          data: result,
          totalRecipes: totalRecipes,
          totalPages: Math.ceil(totalRecipes / limitNum),
          currentPage: pageNum,
        });
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // Single Recipe API
    app.get("/recipes/:id", async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) {
          return res
            .status(400)
            .send({ success: false, message: "Invalid Recipe ID format" });
        }
        const query = { _id: new ObjectId(id) };
        const result = await recipeCollection.findOne(query);

        if (!result) {
          return res
            .status(404)
            .send({ success: false, message: "Recipe not found" });
        }
        res.send({ success: true, data: result });
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // Recipe Post API
    app.post("/recipes", async (req, res) => {
      try {
        const newRecipe = req.body;

        const user = await userCollection.findOne({
          email: newRecipe.authorEmail,
        });

        const existingRecipesCount = await recipeCollection.countDocuments({
          authorEmail: newRecipe.authorEmail,
        });

        if (!user?.isPremium && existingRecipesCount >= 2) {
          return res.status(403).send({
            success: false,
            message:
              "Standard accounts have a 2-recipe limit! Upgrade to Premium to unlock unlimited creations.",
          });
        }

        const result = await recipeCollection.insertOne(newRecipe);
        res.status(201).send({ success: true, insertedId: result.insertedId });
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // RECIPE LIKE & FAVORITE SYSTEM APIS

    // LIKE API
    app.patch("/recipes/:id/like", async (req, res) => {
      try {
        const id = req.params.id;
        const { userEmail } = req.body;

        if (!ObjectId.isValid(id) || !userEmail) {
          return res.status(400).send({
            success: false,
            message: "Invalid parameters or missing email.",
          });
        }

        const recipe = await recipeCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!recipe) {
          return res
            .status(404)
            .send({ success: false, message: "Recipe not found" });
        }

        const likedUsers = recipe.likedUsers || [];
        const hasLiked = likedUsers.includes(userEmail);

        let updateDoc = {};
        if (hasLiked) {
          updateDoc = {
            $pull: { likedUsers: userEmail },
            $inc: { likesCount: -1 },
          };
        } else {
          updateDoc = {
            $addToSet: { likedUsers: userEmail },
            $inc: { likesCount: 1 },
          };
        }

        await recipeCollection.updateOne({ _id: new ObjectId(id) }, updateDoc);
        res.send({ success: true, isLiked: !hasLiked });
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // FAVORITE API
    app.post("/favorites", async (req, res) => {
      try {
        const { recipeId, userEmail } = req.body;

        const exist = await favoriteCollection.findOne({ recipeId, userEmail });
        if (exist) {
          return res.send({ success: false, message: "Already in favorites!" });
        }

        const result = await favoriteCollection.insertOne({
          recipeId,
          userEmail,
          createdAt: new Date(),
        });

        if (result.insertedId) {
          return res.send({ success: true, message: "Added to favorites!" });
        } else {
          return res.send({ success: false, message: "Failed to add!" });
        }
      } catch (error) {
        console.error("Favorite backend error:", error);
        res
          .status(500)
          .send({ success: false, message: "Internal server error" });
      }
    });

    // Featured Recipes API
    app.get("/featured-recipes", async (req, res) => {
      try {
        const result = await recipeCollection
          .find({ isFeatured: true })
          .sort({ featuredAt: -1 })
          .toArray();

        res.send({
          success: true,
          data: result,
        });
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });

    //  STRIPE CHECKOUT & VERIFICATION INTEGRATION

    app.post("/create-checkout-session", async (req, res) => {
      try {
        const { recipeId, title, image, price, userEmail, userId } = req.body;

        if (!title || !price) {
          return res
            .status(400)
            .send({ success: false, message: "Missing title or price" });
        }

        const clientOrigin = process.env.CLIENT_URL;
        if (!clientOrigin) {
          return res
            .status(500)
            .send({ success: false, message: "CLIENT_URL is missing in .env" });
        }

        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          line_items: [
            {
              price_data: {
                currency: "usd",
                product_data: {
                  name: title,
                  images: image ? [image] : [],
                },
                unit_amount: Math.round(Number(price) * 100),
              },
              quantity: 1,
            },
          ],
          mode: "payment",
          metadata: {
            recipeId: recipeId || "membership_upgrade",
            userEmail: userEmail,
            userId: userId || "N/A",
          },
          success_url: `${clientOrigin}/dashboard/purchased-recipes?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${clientOrigin}/browse-recipes`,
        });

        res.send({ success: true, id: session.id, url: session.url });
      } catch (error) {
        console.error("Stripe Checkout error:", error);
        res.status(500).send({ success: false, message: error.message });
      }
    });

    app.post("/verify-payment", async (req, res) => {
      try {
        const { sessionId, userId } = req.body;
        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if (session.payment_status === "paid") {
          const existingPayment = await paymentCollection.findOne({
            transactionId: session.payment_intent,
          });

          if (existingPayment) {
            return res.send({
              success: true,
              message: "Payment already processed",
            });
          }

          const paymentData = {
            userEmail: session.metadata.userEmail,
            userId: userId || session.metadata.userId || "N/A",
            amount: session.amount_total / 100,
            recipeId: session.metadata.recipeId,
            transactionId: session.payment_intent,
            paymentStatus: "paid",
            paidAt: new Date(),
          };

          const result = await paymentCollection.insertOne(paymentData);

          if (session.metadata.recipeId === "membership_upgrade") {
            await userCollection.updateOne(
              { email: session.metadata.userEmail },
              { $set: { isPremium: true, updatedAt: new Date() } },
            );
          }

          return res.send({ success: true, insertedId: result.insertedId });
        }

        res
          .status(400)
          .send({ success: false, message: "Payment status unverified" });
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // OPTIMIZED TRANSACTIONS API (FIXED SYNTAX ERROR)
    app.get("/transactions", async (req, res) => {
      try {
        const userEmail = req.query.email;
        let matchStage = {};
        if (userEmail) {
          matchStage = { userEmail: userEmail };
        }

        const pipeline = [
          { $match: matchStage },
          {
            $addFields: {
              convertedRecipeId: {
                $cond: {
                  if: { $eq: ["$recipeId", "membership_upgrade"] },
                  then: null,
                  else: {
                    $cond: {
                      if: {
                        $regexMatch: {
                          input: "$recipeId",
                          regex: /^[0-9a-fA-F]{24}$/,
                        },
                      },
                      then: { $toObjectId: "$recipeId" },
                      else: "$recipeId",
                    },
                  },
                },
              },
            },
          },
          {
            $lookup: {
              from: "recipes",
              localField: "convertedRecipeId",
              foreignField: "_id",
              as: "recipeDetails",
            },
          },
          {
            $addFields: {
              recipeInfo: { $arrayElemAt: ["$recipeDetails", 0] },
            },
          },
          {
            $project: {
              recipeDetails: 0,
              convertedRecipeId: 0,
            },
          },
          { $sort: { paidAt: -1 } },
        ];

        const result = await paymentCollection.aggregate(pipeline).toArray();
        res.send({ success: true, data: result });
      } catch (error) {
        console.error("Aggregation error in /transactions:", error);
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // RECIPE REPORTS SYSTEM APIS

    app.post("/reports", async (req, res) => {
      try {
        const { recipeId, recipeName, reporterEmail, reason, details } =
          req.body;

        if (!recipeId || !reason) {
          return res.status(400).send({
            success: false,
            message: "Recipe ID and Reason are required.",
          });
        }

        const reportData = {
          recipeId: recipeId,
          recipeName: recipeName || "Unknown Recipe",
          reporterEmail: reporterEmail || "Anonymous",
          reason: reason,
          details: details || "",
          reportedAt: new Date(),
        };

        const result = await reportCollection.insertOne(reportData);
        res.status(201).send({
          success: true,
          insertedId: result.insertedId,
          message: "Report submitted successfully.",
        });
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });

    app.get("/admin/reports", async (req, res) => {
      try {
        const pipeline = [
          {
            $addFields: {
              convertedRecipeId: {
                $cond: {
                  if: {
                    $regexMatch: {
                      input: "$recipeId",
                      regex: /^[0-9a-fA-F]{24}$/,
                    },
                  },
                  then: { $toObjectId: "$recipeId" },
                  else: "$recipeId",
                },
              },
            },
          },
          {
            $lookup: {
              from: "recipes",
              localField: "convertedRecipeId",
              foreignField: "_id",
              as: "targetRecipe",
            },
          },
          {
            $addFields: {
              recipeInfo: { $arrayElemAt: ["$targetRecipe", 0] },
            },
          },
          { $project: { targetRecipe: 0, convertedRecipeId: 0 } },
          { $sort: { reportedAt: -1 } },
        ];

        const result = await reportCollection.aggregate(pipeline).toArray();
        res.send({ success: true, data: result });
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });

    app.delete("/admin/reports/:id", async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) {
          return res
            .status(400)
            .send({ success: false, message: "Invalid Report ID format" });
        }
        const result = await reportCollection.deleteOne({
          _id: new ObjectId(id),
        });
        res.send({
          success: true,
          message: "Report dismissed successfully by Admin.",
          data: result,
        });
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // DASHBOARD OVERVIEW STATISTICS (USER & ADMIN)

    // USER OVERVIEW STATS
    app.get("/user-stats", async (req, res) => {
      try {
        const { email } = req.query;
        if (!email) {
          return res.status(400).send({
            success: false,
            message: "Email query parameter is required",
          });
        }

        const totalRecipes = await recipeCollection.countDocuments({
          authorEmail: email,
        });
        const totalFavorites = await favoriteCollection.countDocuments({
          userEmail: email,
        });

        const recipes = await recipeCollection
          .find({ authorEmail: email })
          .toArray();
        const totalLikesReceived = recipes.reduce(
          (sum, r) => sum + (r.likesCount || 0),
          0,
        );

        res.send({
          success: true,
          data: { totalRecipes, totalFavorites, totalLikesReceived },
        });
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // ADMIN OVERVIEW STATS
    app.get("/admin-stats", async (req, res) => {
      try {
        const totalUsers = await userCollection.countDocuments();
        const totalRecipes = await recipeCollection.countDocuments();
        const totalPremiumMembers = await userCollection.countDocuments({
          isPremium: true,
        });
        const totalReports = await reportCollection.countDocuments();

        res.send({
          success: true,
          data: { totalUsers, totalRecipes, totalPremiumMembers, totalReports },
        });
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // ADMIN CONTROL: MANAGE USERS SUB-APIS

    // All User data API
    app.get("/admin/users", async (req, res) => {
      try {
        const result = await userCollection.find({}).toArray();
        res.send({ success: true, data: result });
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // User block API (FIXED TYPO)
    app.patch("/admin/users/block/:id", async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) {
          return res
            .status(400)
            .send({ success: false, message: "Invalid User ID format" });
        }

        const result = await userCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { isBlocked: true, updatedAt: new Date() } },
        );

        res.send({
          success: true,
          message: "User blocked successfully",
          data: result,
        });
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // User unblock API
    app.patch("/admin/users/unblock/:id", async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) {
          return res
            .status(400)
            .send({ success: false, message: "Invalid User ID format" });
        }

        const result = await userCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { isBlocked: false, updatedAt: new Date() } },
        );

        res.send({
          success: true,
          message: "User unblocked successfully",
          data: result,
        });
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // All Recipes API
    app.get("/admin/recipes", async (req, res) => {
      try {
        const result = await recipeCollection.find({}).toArray();
        res.send({ success: true, data: result });
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // Admin recipe delete API (Remove Recipe action)
    app.delete("/admin/recipes/:id", async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) {
          return res
            .status(400)
            .send({ success: false, message: "Invalid Recipe ID format" });
        }

        await recipeCollection.deleteOne({ _id: new ObjectId(id) });
        await reportCollection.deleteMany({ recipeId: id });

        res.send({
          success: true,
          message:
            "Recipe and its relative reports removed successfully by Admin.",
        });
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // Admin Recipes Update API
    app.put("/admin/recipes/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const { recipeName, category, cuisine, prepTime } = req.body;

        if (!ObjectId.isValid(id)) {
          return res
            .status(400)
            .send({ success: false, message: "Invalid Recipe ID format" });
        }
        const result = await recipeCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              recipeName,
              category,
              cuisine,
              prepTime,
              updatedAt: new Date(),
            },
          },
        );

        res.send({
          success: true,
          message: "Recipe updated successfully with modern parameters",
          data: result,
        });
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // Admin Recipes Featured Toggle API
    app.patch("/admin/recipes/feature/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const { isFeatured } = req.body;

        if (!ObjectId.isValid(id)) {
          return res
            .status(400)
            .send({ success: false, message: "Invalid Recipe ID format" });
        }

        const result = await recipeCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              isFeatured: isFeatured,
              featuredAt: isFeatured ? new Date() : null,
            },
          },
        );

        res.send({
          success: true,
          message: isFeatured
            ? "Recipe marked as Featured!"
            : "Recipe removed from Featured!",
          data: result,
        });
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // ADDED APIS FOR ADD_RECIPE CLIENT-SIDE INTEGRATION

    // Premium status API
    app.get("/users/:email", async (req, res) => {
      try {
        const { email } = req.params;
        const user = await userCollection.findOne({ email: email });
        res.send({ success: true, data: user });
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });

    app.get("/recipes-count", async (req, res) => {
      try {
        const { email } = req.query;
        if (!email) {
          return res
            .status(400)
            .send({ success: false, message: "Email parameter required" });
        }
        const count = await recipeCollection.countDocuments({
          authorEmail: email,
        });
        res.send({ success: true, count });
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // API for finding recipes based on a user's email
    app.get("/my-recipes", async (req, res) => {
      try {
        const email = req.query.email;

        if (!email) {
          return res.status(400).send({
            success: false,
            message: "Email query parameter is required!",
          });
        }

        const query = { authorEmail: email };
        const result = await recipeCollection.find(query).toArray();

        res.send({
          success: true,
          message: "Recipes fetched successfully!",
          data: result,
        });
      } catch (error) {
        console.error("Error fetching user recipes:", error);
        res.status(500).send({
          success: false,
          message: "Internal Server Error while fetching recipes.",
        });
      }
    });

    // Verified Purchase Details along with Recipe Metadata
    app.get("/purchased-details/:id", async (req, res) => {
      try {
        const id = req.params.id; // recipeId
        const email = req.query.email;

        if (!email) {
          return res.status(400).send({
            success: false,
            message: "Email query parameter is required!",
          });
        }

        // Payment Verified
        const paymentRecord = await paymentCollection.findOne({
          recipeId: id,
          userEmail: email,
        });

        if (!paymentRecord) {
          return res.status(404).send({
            success: false,
            message: "Purchase history not found in database!",
          });
        }

        const recipeRecord = await recipeCollection.findOne({
          _id: ObjectId.isValid(id) ? new ObjectId(id) : id,
        });

        res.send({
          success: true,
          message: "Purchase and Recipe verified successfully!",
          data: {
            transactionId: paymentRecord.transactionId,
            userEmail: paymentRecord.userEmail,
            amount: paymentRecord.amount,
            paidAt: paymentRecord.paidAt || paymentRecord.createdAt,
            recipeImage:
              recipeRecord?.recipeImage || recipeRecord?.image || null,
            likesCount: recipeRecord?.likesCount || 0,
          },
        });
      } catch (error) {
        console.error("Error verifying purchase details:", error);
        res
          .status(500)
          .send({ success: false, message: "Internal server error" });
      }
    });

    // API to delete a specific recipe by ID
    app.delete("/recipes/:id", async (req, res) => {
      try {
        const id = req.params.id;

        const query = { _id: new ObjectId(id) };
        const result = await recipeCollection.deleteOne(query);

        if (result.deletedCount === 1) {
          res.send({
            success: true,
            message: "Recipe deleted successfully!",
          });
        } else {
          res.status(404).send({
            success: false,
            message: "Recipe not found!",
          });
        }
      } catch (error) {
        console.error("Error deleting recipe:", error);
        res.status(500).send({
          success: false,
          message: "Internal Server Error while deleting the recipe.",
        });
      }
    });

    app.patch("/recipes/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const updatedData = req.body;
        delete updatedData._id;

        const filter = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: updatedData,
        };

        const result = await recipeCollection.updateOne(filter, updateDoc);

        if (result.modifiedCount > 0 || result.matchedCount > 0) {
          res.send({ success: true, message: "Recipe updated successfully!" });
        } else {
          res
            .status(400)
            .send({ success: false, message: "No changes were made." });
        }
      } catch (error) {
        console.error("Error updating recipe:", error);
        res
          .status(500)
          .send({ success: false, message: "Internal server error." });
      }
    });

    // Updating profile name and image link API

    app.put("/api/user/update", async (req, res) => {
      try {
        const { email, name, image } = req.body;

        if (!email) {
          return res
            .status(400)
            .send({ success: false, message: "Email is required" });
        }

        const filter = {
          email: { $regex: `^${email.trim()}$`, $options: "i" },
        };

        const updateDoc = {
          $set: {
            name: name ? name.trim() : "",
            image: image ? image.trim() : "",
            updatedAt: new Date(),
          },
        };

        const result = await db.collection("user").updateOne(filter, updateDoc);

        if (result.matchedCount === 0) {
          const backupResult = await db
            .collection("users")
            .updateOne(filter, updateDoc);

          if (backupResult.matchedCount === 0) {
            return res.status(404).send({
              success: false,
              message: "User not found in any collection",
            });
          }
        }

        return res
          .status(200)
          .send({ success: true, message: "Profile updated successfully" });
      } catch (error) {
        console.error("Database update error:", error);
        return res.status(500).send({
          success: false,
          message: "Internal Server Error",
          error: error.message,
        });
      }
    });

    // payment success webhook API
    app.post("/api/payment-success-webhook", async (req, res) => {
      const session = req.body;

      try {
        const userEmail = session?.userEmail || session?.metadata?.userEmail;
        const transactionId = session?.id || session?.payment_intent;

        if (!userEmail) {
          return res
            .status(400)
            .json({ success: false, message: "Missing user email" });
        }

        // transactionId
        const existingPayment = await paymentCollection.findOne({
          transactionId,
        });
        if (existingPayment) {
          return res
            .status(200)
            .json({ success: true, message: "Already processed" });
        }

        await paymentCollection.insertOne({
          userEmail,
          recipeId: "membership_upgrade",
          title: "RecipeHub Pro Premium Membership",
          price: 19.99,
          transactionId,
          paymentStatus: "paid",
          paidAt: new Date(),
        });

        const updateResult = await userCollection.updateOne(
          { email: userEmail },
          {
            $set: {
              isPremium: true,
              role: "premium",
              updatedAt: new Date(),
            },
          },
        );

        console.log(`User ${userEmail} successfully upgraded to Premium!`);
        return res
          .status(200)
          .json({ success: true, message: "Membership upgraded successfully" });
      } catch (error) {
        console.error("Error upgrading membership:", error);
        return res
          .status(500)
          .json({ success: false, message: "Internal server error" });
      }
    });

    // --- FAVORITES API ---
    app.get("/favorites", async (req, res) => {
      try {
        const { email } = req.query;
        if (!email)
          return res
            .status(400)
            .send({ success: false, message: "Email required" });

        const pipeline = [
          { $match: { userEmail: email } },
          {
            $addFields: {
              convertedRecipeId: {
                $cond: {
                  if: {
                    $regexMatch: {
                      input: "$recipeId",
                      regex: /^[0-9a-fA-F]{24}$/,
                    },
                  },
                  then: { $toObjectId: "$recipeId" },
                  else: "$recipeId",
                },
              },
            },
          },
          {
            $lookup: {
              from: "recipes",
              localField: "convertedRecipeId",
              foreignField: "_id",
              as: "recipeDetails",
            },
          },
          {
            $addFields: { recipeInfo: { $arrayElemAt: ["$recipeDetails", 0] } },
          },
          { $project: { recipeDetails: 0, convertedRecipeId: 0 } },
          { $sort: { createdAt: -1 } },
        ];

        const result = await favoriteCollection.aggregate(pipeline).toArray();
        res.send({ success: true, data: result });
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });

    app.delete("/favorites/:id", async (req, res) => {
      try {
        const result = await favoriteCollection.deleteOne({
          _id: new ObjectId(req.params.id),
        });
        res.send({ success: true, deletedCount: result.deletedCount });
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // Admin All reports Api
    app.get("/reports", async (req, res) => {
      try {
        const result = await reportCollection
          .aggregate([
            {
              $addFields: {
                recipeObjectId: {
                  $cond: {
                    if: { $eq: [{ $type: "$recipeId" }, "string"] },
                    then: { $toObjectId: "$recipeId" },
                    else: "$recipeId",
                  },
                },
              },
            },
            {
              $lookup: {
                from: "recipes",
                localField: "recipeObjectId",
                foreignField: "_id",
                as: "recipeDetails",
              },
            },
            {
              $unwind: {
                path: "$recipeDetails",
                preserveNullAndEmptyArrays: true,
              },
            },
          ])
          .toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    app.delete("/reports/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const { action, recipeId } = req.query;

        if (action === "delete" && recipeId) {
          await recipeCollection.deleteOne({ _id: new ObjectId(recipeId) });
        }

        const result = await reportCollection.deleteOne({
          _id: new ObjectId(id),
        });

        res.send({ success: true, deletedCount: result.deletedCount });
      } catch (error) {
        res.status(500).send({ success: false, message: error.message });
      }
    });

    // Transactions API
    app.get("/admin/transactions", async (req, res) => {
      try {
        const transactions = await paymentCollection
          .find()
          .sort({ paidAt: -1 })
          .toArray();

        res.send(transactions);
      } catch (error) {
        res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });
  } catch (error) {
    console.error("MongoDB engine initialization crash:", error);
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("RecipeHub Production Server is Online!");
});

app.listen(PORT, () => {
  console.log(`Server is perfectly running on port: ${PORT}`);
});
