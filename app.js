var createError = require("http-errors");
var express = require("express");
var path = require("path");
var cookieParser = require("cookie-parser");
var logger = require("morgan");

var indexRouter = require("./routes/index");
var adminRouter = require("./routes/admin");
var clientRouter = require("./routes/client");

var app = express();

// view engine setup
app.set("views", __dirname);
app.set("view engine", "ejs");

app.use(logger("dev"));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use("/admr", express.static(path.join(__dirname, "admin"))); // admin static resource link
app.use("/clir", express.static(path.join(__dirname, "client"))); // client static resource link

app.use("/", indexRouter);
app.use("/adm", adminRouter); // admin CRUD link
app.use("/cli", clientRouter); // client CRUD link

// catch 404 and forward to error handler
app.use(function (req, res, next) {
    next(createError(404));
});

// error handler
app.use(function (err, req, res, next) {
    // set locals, only providing error in development
    res.locals.message = err.message;
    res.locals.error = req.app.get("env") === "development" ? err : {};

    // render the error page
    res.status(err.status || 500);
    res.render("views/error");
});

module.exports = app;
