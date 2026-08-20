#include <napi.h>
#include <sapnwrfc.h>
#include <string>
#include <vector>
#include <cstring>
#include <cstdio>

// On Linux with SAPwithUNICODE, SAP_UC = char16_t (UTF-16).
// String conversion between JS UTF-8 and SAP_UC (UTF-16).

static std::u16string u8toU16(const std::string& s) {
    std::u16string r;
    r.reserve(s.size());
    size_t i = 0;
    while (i < s.size()) {
        unsigned char c = (unsigned char)s[i];
        uint32_t cp;
        if (c < 0x80)                                    { cp = c; i++; }
        else if ((c & 0xE0) == 0xC0 && i+1 < s.size()) { cp = ((c&0x1F)<<6)|(s[i+1]&0x3F); i+=2; }
        else if ((c & 0xF0) == 0xE0 && i+2 < s.size()) { cp = ((c&0x0F)<<12)|((s[i+1]&0x3F)<<6)|(s[i+2]&0x3F); i+=3; }
        else if ((c & 0xF8) == 0xF0 && i+3 < s.size()) { cp = ((c&0x07)<<18)|((s[i+1]&0x3F)<<12)|((s[i+2]&0x3F)<<6)|(s[i+3]&0x3F); i+=4; }
        else { i++; continue; }
        if (cp < 0x10000) {
            r += (char16_t)cp;
        } else {
            cp -= 0x10000;
            r += (char16_t)(0xD800 | (cp >> 10));
            r += (char16_t)(0xDC00 | (cp & 0x3FF));
        }
    }
    return r;
}

static std::string u16toU8(const SAP_UC* buf, unsigned maxLen) {
    std::string r;
    for (unsigned i = 0; i < maxLen; i++) {
        uint32_t cp = (uint16_t)buf[i];
        if (cp == 0) break;
        if (cp >= 0xD800 && cp <= 0xDBFF && i+1 < maxLen) {
            uint32_t lo = (uint16_t)buf[i+1];
            if (lo >= 0xDC00 && lo <= 0xDFFF) { cp = 0x10000 + ((cp-0xD800)<<10) + (lo-0xDC00); i++; }
        }
        if      (cp < 0x80)    { r += (char)cp; }
        else if (cp < 0x800)   { r += (char)(0xC0|(cp>>6));  r += (char)(0x80|(cp&0x3F)); }
        else if (cp < 0x10000) { r += (char)(0xE0|(cp>>12)); r += (char)(0x80|((cp>>6)&0x3F)); r += (char)(0x80|(cp&0x3F)); }
        else                   { r += (char)(0xF0|(cp>>18)); r += (char)(0x80|((cp>>12)&0x3F)); r += (char)(0x80|((cp>>6)&0x3F)); r += (char)(0x80|(cp&0x3F)); }
    }
    return r;
}

// ─── JSON builder (runs in worker thread — no Napi) ───────────────────────────

static std::string jsonStr(const std::string& s) {
    std::string r;
    r.reserve(s.size() + 2);
    r += '"';
    for (unsigned char c : s) {
        if      (c == '"')  r += "\\\"";
        else if (c == '\\') r += "\\\\";
        else if (c == '\n') r += "\\n";
        else if (c == '\r') r += "\\r";
        else if (c == '\t') r += "\\t";
        else if (c < 0x20)  { char b[8]; snprintf(b, sizeof(b), "\\u%04x", c); r += b; }
        else r += (char)c;
    }
    r += '"';
    return r;
}

static std::string serializeStruct(RFC_STRUCTURE_HANDLE sh, RFC_TYPE_DESC_HANDLE td);
static std::string serializeTable(RFC_TABLE_HANDLE th, RFC_TYPE_DESC_HANDLE td);

static std::string serializeValue(DATA_CONTAINER_HANDLE h, RFCTYPE type, const SAP_UC* name, RFC_TYPE_DESC_HANDLE td) {
    RFC_ERROR_INFO err;
    memset(&err, 0, sizeof(err));

    switch (type) {
        case RFCTYPE_STRING:
        case RFCTYPE_CHAR:
        case RFCTYPE_NUM:
        case RFCTYPE_DATE:
        case RFCTYPE_TIME:
        case RFCTYPE_BCD:
        case RFCTYPE_DECF16:
        case RFCTYPE_DECF34:
        case RFCTYPE_BYTE:
        case RFCTYPE_XSTRING: {
            unsigned needed = 0;
            RfcGetString(h, name, nullptr, 0, &needed, &err);
            if (needed == 0) return "\"\"";
            std::vector<SAP_UC> buf(needed + 1, 0);
            unsigned got = 0;
            RfcGetString(h, name, buf.data(), needed + 1, &got, &err);
            return jsonStr(u16toU8(buf.data(), got));
        }
        case RFCTYPE_INT: {
            RFC_INT v = 0; RfcGetInt(h, name, &v, &err);
            return std::to_string(v);
        }
        case RFCTYPE_INT1: {
            RFC_INT1 v = 0; RfcGetInt1(h, name, &v, &err);
            return std::to_string((unsigned)v);
        }
        case RFCTYPE_INT2: {
            RFC_INT2 v = 0; RfcGetInt2(h, name, &v, &err);
            return std::to_string((int)v);
        }
        case RFCTYPE_INT8: {
            RFC_INT8 v = 0; RfcGetInt8(h, name, &v, &err);
            return std::to_string(v);
        }
        case RFCTYPE_FLOAT: {
            RFC_FLOAT v = 0.0; RfcGetFloat(h, name, &v, &err);
            char b[64]; snprintf(b, sizeof(b), "%.17g", v); return b;
        }
        case RFCTYPE_STRUCTURE: {
            RFC_STRUCTURE_HANDLE sh = nullptr;
            if (RfcGetStructure(h, name, &sh, &err) == RFC_OK && sh)
                return serializeStruct(sh, td);
            return "null";
        }
        case RFCTYPE_TABLE: {
            RFC_TABLE_HANDLE th = nullptr;
            if (RfcGetTable(h, name, &th, &err) == RFC_OK && th)
                return serializeTable(th, td);
            return "[]";
        }
        default: {
            char b[32]; snprintf(b, sizeof(b), "\"<type:%d>\"", (int)type);
            return b;
        }
    }
}

static std::string serializeStruct(RFC_STRUCTURE_HANDLE sh, RFC_TYPE_DESC_HANDLE td) {
    RFC_ERROR_INFO err;
    unsigned count = 0;
    RfcGetFieldCount(td, &count, &err);
    std::string r = "{";
    bool first = true;
    for (unsigned i = 0; i < count; i++) {
        RFC_FIELD_DESC fd; memset(&fd, 0, sizeof(fd));
        if (RfcGetFieldDescByIndex(td, i, &fd, &err) != RFC_OK) continue;
        if (!first) r += ',';
        first = false;
        r += jsonStr(u16toU8(fd.name, 31)) + ':';
        r += serializeValue(sh, fd.type, fd.name, fd.typeDescHandle);
    }
    return r + '}';
}

static std::string serializeTable(RFC_TABLE_HANDLE th, RFC_TYPE_DESC_HANDLE td) {
    RFC_ERROR_INFO err;
    unsigned rows = 0;
    RfcGetRowCount(th, &rows, &err);
    if (rows == 0 || RfcMoveToFirstRow(th, &err) != RFC_OK) return "[]";
    std::string r = "[";
    for (unsigned row = 0; row < rows; row++) {
        if (row > 0) r += ',';
        RFC_STRUCTURE_HANDLE rh = RfcGetCurrentRow(th, &err);
        r += rh ? serializeStruct(rh, td) : "null";
        if (row < rows - 1) RfcMoveToNextRow(th, &err);
    }
    return r + ']';
}

static std::string serializeOutput(RFC_FUNCTION_HANDLE fh, RFC_FUNCTION_DESC_HANDLE fd) {
    RFC_ERROR_INFO err;
    unsigned count = 0;
    RfcGetParameterCount(fd, &count, &err);
    std::string r = "{";
    bool first = true;
    for (unsigned i = 0; i < count; i++) {
        RFC_PARAMETER_DESC pd; memset(&pd, 0, sizeof(pd));
        if (RfcGetParameterDescByIndex(fd, i, &pd, &err) != RFC_OK) continue;
        if (pd.direction == RFC_IMPORT) continue;
        if (!first) r += ',';
        first = false;
        r += jsonStr(u16toU8(pd.name, 31)) + ':';
        r += serializeValue(fh, pd.type, pd.name, pd.typeDescHandle);
    }
    return r + '}';
}

// ─── AsyncWorker ─────────────────────────────────────────────────────────────

struct RfcWorker : public Napi::AsyncWorker {
    std::vector<std::u16string> connKeys, connVals;
    std::vector<RFC_CONNECTION_PARAMETER> connParams;
    std::u16string funcName;
    std::vector<std::u16string> importKeys, importVals;
    Napi::Promise::Deferred deferred;
    std::string outputJson;
    std::string errorMsg;

    RfcWorker(Napi::Env env,
              std::vector<std::u16string> ck, std::vector<std::u16string> cv,
              std::u16string fn,
              std::vector<std::u16string> ik, std::vector<std::u16string> iv)
        : Napi::AsyncWorker(env),
          connKeys(std::move(ck)), connVals(std::move(cv)),
          funcName(std::move(fn)),
          importKeys(std::move(ik)), importVals(std::move(iv)),
          deferred(Napi::Promise::Deferred::New(env))
    {
        connParams.resize(connKeys.size());
        for (size_t i = 0; i < connKeys.size(); i++) {
            connParams[i].name  = (const SAP_UC*)connKeys[i].c_str();
            connParams[i].value = (const SAP_UC*)connVals[i].c_str();
        }
    }

    void Execute() override {
        RFC_ERROR_INFO err;
        memset(&err, 0, sizeof(err));

        RFC_CONNECTION_HANDLE conn = RfcOpenConnection(
            connParams.data(), (unsigned)connParams.size(), &err);
        if (!conn) {
            errorMsg = u16toU8(err.message, 512) + " [" + u16toU8(err.key, 128) + "]";
            return;
        }

        RFC_FUNCTION_DESC_HANDLE funcDesc = RfcGetFunctionDesc(
            conn, (const SAP_UC*)funcName.c_str(), &err);
        if (!funcDesc) {
            errorMsg = u16toU8(err.message, 512) + " [" + u16toU8(err.key, 128) + "]";
            RfcCloseConnection(conn, nullptr);
            return;
        }

        RFC_FUNCTION_HANDLE fh = RfcCreateFunction(funcDesc, &err);
        if (!fh) {
            errorMsg = u16toU8(err.message, 512) + " [" + u16toU8(err.key, 128) + "]";
            RfcCloseConnection(conn, nullptr);
            return;
        }

        for (size_t i = 0; i < importKeys.size(); i++) {
            RfcSetString(fh,
                (const SAP_UC*)importKeys[i].c_str(),
                (const SAP_UC*)importVals[i].c_str(),
                (unsigned)importVals[i].size(), &err);
        }

        if (RfcInvoke(conn, fh, &err) != RFC_OK) {
            errorMsg = u16toU8(err.message, 512) + " [" + u16toU8(err.key, 128) + "]";
            RfcDestroyFunction(fh, nullptr);
            RfcCloseConnection(conn, nullptr);
            return;
        }

        outputJson = serializeOutput(fh, funcDesc);
        RfcDestroyFunction(fh, nullptr);
        RfcCloseConnection(conn, nullptr);
    }

    void OnOK() override {
        Napi::Env env = Env();
        Napi::Object out = Napi::Object::New(env);
        if (!errorMsg.empty()) {
            out.Set("error", Napi::String::New(env, errorMsg));
        } else {
            out.Set("json", Napi::String::New(env, outputJson));
        }
        deferred.Resolve(out);
    }

    void OnError(const Napi::Error& e) override {
        Napi::Env env = Env();
        Napi::Object out = Napi::Object::New(env);
        out.Set("error", Napi::String::New(env, e.Message()));
        deferred.Resolve(out);
    }
};

// ─── Exported function ────────────────────────────────────────────────────────

static Napi::Value InvokeRfc(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 3 || !info[0].IsObject() || !info[1].IsString() || !info[2].IsObject()) {
        Napi::TypeError::New(env,
            "Expected: (params: object, funcName: string, importParams: object)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    auto parseStrObj = [](Napi::Object obj,
                          std::vector<std::u16string>& keys,
                          std::vector<std::u16string>& vals) {
        Napi::Array names = obj.GetPropertyNames();
        for (uint32_t i = 0; i < names.Length(); i++) {
            std::string k = names.Get(i).As<Napi::String>().Utf8Value();
            std::string v = obj.Get(k).As<Napi::String>().Utf8Value();
            keys.push_back(u8toU16(k));
            vals.push_back(u8toU16(v));
        }
    };

    std::vector<std::u16string> connKeys, connVals;
    parseStrObj(info[0].As<Napi::Object>(), connKeys, connVals);

    std::u16string funcName = u8toU16(info[1].As<Napi::String>().Utf8Value());

    std::vector<std::u16string> importKeys, importVals;
    parseStrObj(info[2].As<Napi::Object>(), importKeys, importVals);

    auto* worker = new RfcWorker(env,
        std::move(connKeys), std::move(connVals),
        std::move(funcName),
        std::move(importKeys), std::move(importVals));
    Napi::Promise promise = worker->deferred.Promise();
    worker->Queue();
    return promise;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("invokeRfc", Napi::Function::New(env, InvokeRfc));
    return exports;
}

NODE_API_MODULE(rfcaddon, Init)
