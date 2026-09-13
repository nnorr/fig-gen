// fig-gen test fixture (self-written): a top that instantiates a module with no
// definition (a hard macro), so simulation must report it instead of running.
module uses_macro (
  input  logic       clk,
  input  logic [3:0] a,
  output logic [3:0] q
);
  vendor_ram_macro u_ram (.CLK(clk), .A(a), .Q(q));
endmodule
